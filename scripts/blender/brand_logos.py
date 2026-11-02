"""
Cuts the owner's fr33world logos (white and green on black, assets/brand/*.jpg) out of their
black background and writes the client's brand images, plus app icons that keep the black.

    blender -b --factory-startup --python scripts/blender/brand_logos.py -- <repo root>

Alpha comes from brightness (black → clear, anything brighter than ~25% → solid) and colour
is un-premultiplied from black, so anti-aliased and grungy edges stay clean on any background.
Prints the brand green measured from the logo.
"""

import os
import sys

import bpy
import numpy as np


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px


def save(px, path, size=None, fmt="PNG"):
    h, w = px.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels[:] = px.ravel()
    if size:
        img.scale(*size)
    img.filepath_raw = path
    img.file_format = fmt
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene = bpy.context.scene
    # Save the pixels as they are: Blender's default view transform (AgX) would mute the green.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = fmt
    scene.render.image_settings.color_mode = "RGBA"
    if fmt == "WEBP":
        scene.render.image_settings.quality = 90
    img.save_render(path, scene=scene)
    bpy.data.images.remove(img)
    print(f"WROTE {path}")


def cut_out(px, lo=0.05, hi=0.25):
    rgb = px[..., :3]
    a = np.clip((rgb.max(axis=2) - lo) / (hi - lo), 0, 1)
    out = np.zeros_like(px)
    out[..., :3] = np.clip(rgb / np.maximum(a, 1e-3)[..., None], 0, 1)
    out[..., 3] = a
    return out


def crop(px, margin=0.03):
    ys, xs = np.nonzero(px[..., 3] > 0.04)
    h, w = px.shape[:2]
    m = int(max(h, w) * margin)
    y0, y1 = max(0, ys.min() - m), min(h, ys.max() + m + 1)
    x0, x1 = max(0, xs.min() - m), min(w, xs.max() + m + 1)
    return px[y0:y1, x0:x1]


def brand_green(px):
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    mask = (g > 0.6) & (r < g * 0.75) & (b < g * 0.4)
    c = px[mask][:, :3].mean(axis=0)
    return "#" + "".join(f"{int(round(v * 255)):02x}" for v in c)


def main():
    root = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
    src = os.path.join(root, "assets/brand")
    out = os.path.join(root, "apps/client/public/brand")
    emblem = load(os.path.join(src, "fr33world-emblem.jpg"))
    wordmark = load(os.path.join(src, "fr33world-wordmark.jpg"))
    print(f"GREEN {brand_green(emblem)} {brand_green(wordmark)}")

    em = crop(cut_out(emblem))
    side = max(em.shape[:2])
    square = np.zeros((side, side, 4), dtype=np.float32)
    y = (side - em.shape[0]) // 2
    x = (side - em.shape[1]) // 2
    square[y : y + em.shape[0], x : x + em.shape[1]] = em
    save(square, os.path.join(out, "emblem.webp"), (512, 512), "WEBP")

    wm = crop(cut_out(wordmark), margin=0.01)
    h, w = wm.shape[:2]
    save(wm, os.path.join(out, "wordmark.webp"), (1200, round(1200 * h / w)), "WEBP")

    # App icons and favicon keep the black square: they sit on home screens and browser tabs.
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png"), (64, "favicon.png")):
        save(emblem.copy(), os.path.join(out, name), (size, size), "PNG")


main()
