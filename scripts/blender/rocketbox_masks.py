"""
Recolouring masks for a Rocketbox avatar's two parts (the game tints in its shaders):

    blender -b --factory-startup --python scripts/blender/rocketbox_masks.py -- \
        <avatar.fbx> <out_dir> <id> <bare: none|arms|legs|arms,legs>

writes <out_dir>/rb_<id>_outfit.mask.png (512 px, over the body texture's layout: R top,
G bottom, B shoes, A skin) and <out_dir>/rb_<id>_face.mask.png (over the head texture's: R a
full beard's area, G a goatee's, B a moustache's, A skin), and <out_dir>/rb_<id>.skin.json: the
avatar's skin colour (sRGB; the shader moves skin from it to the chosen tone) and each clothes
region's mean luminance (linear; the shader dyes relative to it).

Regions come from the skin weights (each triangle goes to its dominant bone's region),
rasterised into texture space. On the face, skin is everything below the hairline but the
eyes, the mouth's inside and dark hair. On the outfit, it is pixels close to the face's own
skin colour, only where an outfit can show skin: hands and neck always, arms and legs when
`bare` says (colour alone can't tell dark skin from brown trousers), with small holes closed. Facial hair areas come from the
face's landmarks (jaw, lips, nose, cheeks, eyes): the parts of the head in front of the ears,
below the cheekbones and above the jaw line.
"""

import json
import os
import sys

import bpy
import numpy as np

SIZE = 512


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    fbx, out_dir, ident, bare = args[0], args[1], args[2], args[3].split(",")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx)
    for o in bpy.data.objects:
        o.animation_data_clear()
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    mesh = next(o for o in bpy.data.objects if o.type == "MESH")
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()

    me = mesh.data
    groups = {g.index: g.name for g in mesh.vertex_groups}
    slot = {m.name.split("_")[-1]: i for i, m in enumerate(me.materials)}
    uv = me.uv_layers.active.data

    def colour(part):
        node = next(
            n
            for n in me.materials[slot[part]].node_tree.nodes
            if n.type == "TEX_IMAGE" and n.image and n.image.filepath.endswith(f"_{part}_color.tga")
        )
        img = node.image
        w, h = img.size
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[..., :3]
        # Down to the mask's size (box filter).
        f = w // SIZE
        return px.reshape(SIZE, f, SIZE, f, 3).mean(axis=(1, 3))

    def bone_of(poly):
        weight = {}
        for vi in poly.vertices:
            for g in me.vertices[vi].groups:
                weight[g.group] = weight.get(g.group, 0) + g.weight
        return groups[max(weight, key=weight.get)] if weight else ""

    def raster(target, poly):
        """Fills the polygon's area in texture space (UV y up: rows from the bottom)."""
        pts = [uv[li].uv for li in poly.loop_indices]
        for k in range(1, len(pts) - 1):
            tri = np.array([pts[0], pts[k], pts[k + 1]]) * SIZE
            x0, y0 = np.floor(tri.min(0)).astype(int)
            x1, y1 = np.ceil(tri.max(0)).astype(int)
            x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, SIZE - 1), min(y1, SIZE - 1)
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            (ax, ay), (bx, by), (cx, cy) = tri
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(d) < 1e-9:
                continue
            l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
            l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
            inside = (l1 >= -0.03) & (l2 >= -0.03) & (1 - l1 - l2 >= -0.03)
            target[y0 : y1 + 1, x0 : x1 + 1][inside] = 1

    def skin_like(px, mean):
        r, g, b = px[..., 0], px[..., 1], px[..., 2]
        mx, mn = px.max(-1), px.min(-1)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
        warm = (r > g) & (g >= b * 0.92) & (sat > 0.08) & (sat < 0.8) & (mx > 0.05)
        if mean is None:
            return warm
        s = px.sum(-1, keepdims=True) + 1e-6
        ms = mean.sum() + 1e-6
        chroma = np.linalg.norm(px / s - mean / ms, axis=-1)
        lum, mlum = px.mean(-1), mean.mean()
        return warm & (chroma < 0.045) & (lum > mlum * 0.35) & (lum < mlum * 2.2)

    # ---- the face: its landmarks, its skin and the skin's mean colour ---------------------
    # (Rest positions, metres, -Y forward, Z up.)
    bones = arm.data.bones
    at = lambda name: np.array(bones[name].head_local)  # noqa: E731
    jaw, lip_up, lip_down, nose = at("Bip01 MJaw"), at("Bip01 MUpperLip"), at("Bip01 MBottomLip"), at("Bip01 MNose")
    corner = abs(at("Bip01 LMouthCorner")[0])
    cheek_z = (at("Bip01 LCheek")[2] + at("Bip01 RCheek")[2]) / 2
    cheek_x = abs(at("Bip01 LCheek")[0])
    eye_y = (at("Bip01 LEye")[1] + at("Bip01 REye")[1]) / 2
    eye_z = (at("Bip01 LEye")[2] + at("Bip01 REye")[2]) / 2
    brow_z = at("Bip01 MMiddleEyebrow")[2]
    co = lambda poly: np.mean([me.vertices[v].co for v in poly.vertices], axis=0)  # noqa: E731

    # The eyes, teeth, gums and tongue are small islands of their own in the head's texture
    # layout; the face, scalp and ears one big one.
    small = small_islands(me, slot["head"])

    def inside(poly):
        return poly.index in small or bone_of(poly) in ("Bip01 LEye", "Bip01 REye", "Bip01 MTongue")

    head_px = colour("head")
    cheeks = np.zeros((SIZE, SIZE), np.float32)
    below_hair = np.zeros((SIZE, SIZE), np.float32)
    for poly in me.polygons:
        if poly.material_index != slot["head"]:
            continue
        x, y, z = co(poly)
        # Cheeks and the bridge of the nose: bare skin on every face (beards start lower).
        if y < eye_y and abs(x) < cheek_x + 0.01 and cheek_z - 0.005 < z < eye_z - 0.008:
            raster(cheeks, poly)
        # Face, ears and neck, below the hairline (a scalp's hair is painted on), and the
        # forehead up to where hair can start.
        if z < brow_z + 0.025 or (y < eye_y - 0.01 and z < brow_z + 0.07):
            raster(below_hair, poly)
    warm = skin_like(head_px, None) & (cheeks > 0)
    mean = np.median(head_px[warm], axis=0) if warm.sum() > 20 else np.array([0.6, 0.45, 0.35])

    # Face skin: below the hairline, not the eyes or the mouth's inside, not dark hair
    # (eyebrows, sideburns), holes closed.
    not_face = np.zeros((SIZE, SIZE), np.float32)
    for poly in me.polygons:
        if poly.material_index == slot["head"] and inside(poly):
            raster(not_face, poly)
    head = np.zeros((SIZE, SIZE), np.float32)
    for poly in me.polygons:
        if poly.material_index == slot["head"]:
            raster(head, poly)
    # Below the hairline, everything but dark hair; above it (a bald or shaved scalp), only
    # pixels the colour of the face's skin.
    lum = head_px.mean(-1)
    scalp = shifted(shifted((head > 0) & skin_like(head_px, mean), 2, np.logical_and), 2, np.logical_or)
    face_skin = ((below_hair > 0) & (lum > mean.mean() * 0.45)) | scalp
    face_skin = close(face_skin & (not_face == 0), 3) & (head > 0) & (not_face == 0)
    face_skin = face_skin | (shifted(face_skin, 3, np.logical_or) & (head == 0))

    # Facial hair areas from the landmarks.
    beard = np.zeros((SIZE, SIZE), np.float32)
    goatee = np.zeros((SIZE, SIZE), np.float32)
    moustache = np.zeros((SIZE, SIZE), np.float32)
    for poly in me.polygons:
        if poly.material_index != slot["head"]:
            continue
        if inside(poly):
            continue
        x, y, z = co(poly)
        front = y < eye_y + 0.06  # in front of the ears
        lips = abs(x) < corner + 0.004 and lip_down[2] - 0.006 < z < lip_up[2] + 0.004 and y < lip_up[1] + 0.02
        if front and jaw[2] - 0.075 < z < cheek_z - 0.012 and not lips:
            raster(beard, poly)
        if front and abs(x) < 0.028 and jaw[2] - 0.065 < z < lip_down[2] - 0.006:
            raster(goatee, poly)
        if front and abs(x) < corner + 0.012 and lip_up[2] - 0.002 < z < nose[2] - 0.004 and y < nose[1] + 0.03:
            raster(moustache, poly)

    # ---- the outfit: clothes regions and the skin it shows ----------------------------------
    body_px = colour("body")
    top = np.zeros((SIZE, SIZE), np.float32)
    bottom = np.zeros((SIZE, SIZE), np.float32)
    shoes = np.zeros((SIZE, SIZE), np.float32)
    may_skin = np.zeros((SIZE, SIZE), np.float32)
    waist = np.zeros((SIZE, SIZE), np.float32)
    for poly in me.polygons:
        if poly.material_index != slot["body"]:
            continue
        bone = bone_of(poly)
        if bone in ("Bip01 Pelvis", "Bip01 Spine"):
            raster(waist, poly)
        if any(k in bone for k in ("Foot", "Toe")):
            raster(shoes, poly)
        elif any(k in bone for k in ("Thigh", "Calf", "Pelvis")):
            raster(bottom, poly)
            if "legs" in bare:
                raster(may_skin, poly)
        elif any(k in bone for k in ("Spine", "Clavicle", "UpperArm", "Forearm")):
            raster(top, poly)
            if "arms" in bare and any(k in bone for k in ("UpperArm", "Forearm")):
                raster(may_skin, poly)
        if any(k in bone for k in ("Hand", "Finger", "Neck", "Head")):
            raster(may_skin, poly)
    # Where top meets bottom, bones only roughly divide them: there each pixel goes with the
    # one it's closer to in colour.
    core_top, core_bottom = (top > 0) & (waist == 0), (bottom > 0) & (waist == 0)
    if core_top.any() and core_bottom.any():
        to_top = np.linalg.norm(body_px - body_px[core_top].mean(0), axis=-1)
        to_bottom = np.linalg.norm(body_px - body_px[core_bottom].mean(0), axis=-1)
        nearer_top = blur((to_top < to_bottom).astype(np.float32), 2) > 0.5
        either = (waist > 0) & ((top > 0) | (bottom > 0))
        top = np.where(either, nearer_top, top > 0).astype(np.float32)
        bottom = np.where(either, ~nearer_top, bottom > 0).astype(np.float32)
    body_skin = close(skin_like(body_px, mean) & (may_skin > 0), 3) & (may_skin > 0)
    # Each region's mean luminance (linear, as the shader sees the texture), skin left out.
    linear = np.where(body_px <= 0.04045, body_px / 12.92, ((body_px + 0.055) / 1.055) ** 2.4)
    luma = linear @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    cloth = [
        float(luma[(m > 0) & ~body_skin].mean()) if ((m > 0) & ~body_skin).any() else 0.2
        for m in (top, bottom, shoes)
    ]

    # Out into the layout's padding a little, so lower detail levels don't show seams.
    empty = (top == 0) & (bottom == 0) & (shoes == 0)
    top, bottom, shoes = (np.maximum(m, shifted(m > 0, 4, np.logical_or) & empty) for m in (top, bottom, shoes))
    body_skin = body_skin | (shifted(body_skin, 3, np.logical_or) & empty)
    save(f"{out_dir}/rb_{ident}_outfit.mask.png", top, bottom, shoes, body_skin)
    # Facial hair fades out at its edges.
    beard, goatee, moustache = (blur(m, 4) for m in (beard, goatee, moustache))
    save(f"{out_dir}/rb_{ident}_face.mask.png", beard, goatee, moustache, face_skin)
    if os.environ.get("MASK_DEBUG"):
        debug(f"{out_dir}/debug_{ident}_face.png", head_px, [(beard, (1, 0, 0)), (goatee, (0, 1, 0)), (moustache, (0, 0, 1)), (face_skin, (1, 1, 0))])
        debug(f"{out_dir}/debug_{ident}_outfit.png", body_px, [(top, (1, 0, 0)), (bottom, (0, 1, 0)), (shoes, (0, 0, 1)), (body_skin, (1, 1, 0))])
    with open(f"{out_dir}/rb_{ident}.skin.json", "w") as f:
        json.dump({"skin": [round(float(v), 4) for v in mean], "cloth": [round(v, 4) for v in cloth]}, f)
    print("MASKS", ident, "skin", [round(float(v), 3) for v in mean], "face skin", round(float(face_skin.mean()), 3), "body skin", round(float(body_skin.mean()), 3))


def small_islands(me, material):
    """The polygons (indices) of the material's small texture islands (under 3% of its area)."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.active
    faces = [f for f in bm.faces if f.material_index == material]
    parent = {f.index: f.index for f in faces}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for f in faces:
        for loop in f.loops:
            other = loop.link_loop_radial_next
            g = other.face
            if g is f or g.index not in parent:
                continue
            # Joined in the texture too: the shared edge's two ends have the same UVs.
            a, b = loop[uv].uv, loop.link_loop_next[uv].uv
            c, d = other.link_loop_next[uv].uv, other[uv].uv
            if (a - c).length < 1e-5 and (b - d).length < 1e-5:
                parent[find(f.index)] = find(g.index)
    area = {}
    for f in faces:
        r = find(f.index)
        area[r] = area.get(r, 0) + f.calc_area()
    total = sum(area.values())
    out = {f.index for f in faces if area[find(f.index)] < 0.03 * total}
    bm.free()
    return out


def shifted(m, r, combine):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out = combine(out, np.roll(np.roll(m, dy, 0), dx, 1))
    return out


def close(m, r):
    """Fills holes and gaps up to about 2r pixels across."""
    return shifted(shifted(m, r, np.logical_or), r, np.logical_and)


def blur(m, r):
    """A box blur (soft edges)."""
    out = np.zeros_like(m, np.float32)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out += np.roll(np.roll(m.astype(np.float32), dy, 0), dx, 1)
    return out / (2 * r + 1) ** 2


def debug(path, px, layers):
    """The texture with each mask tinted over it (checking by eye)."""
    out = px.copy()
    for m, c in layers:
        mm = m.astype(np.float32)[..., None]
        out = out * (1 - 0.45 * mm) + 0.45 * mm * np.array(c, np.float32)
    img = bpy.data.images.new("debug", SIZE, SIZE, alpha=True)
    img.pixels = np.concatenate([out, np.ones((SIZE, SIZE, 1), np.float32)], -1).ravel()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()


def save(path, r, g, b, a):
    img = bpy.data.images.new("mask", SIZE, SIZE, alpha=True)
    px = np.stack([r, g, b, a.astype(np.float32)], axis=-1).astype(np.float32)
    img.pixels = px.ravel()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()


main()
