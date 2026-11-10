"""
The modals' pictures: what the game's shops sell (guns, rounds, the licence, Sunny's food), the
USDC coin, and an enamel-and-metal medallion for each place and faction. Everything is modelled
here, each on a clear background, as PNGs for scripts/assets/shop-art.mjs to shrink. Medallion
shapes come from game-icons.net (CC BY 3.0); the coin is USDC's own mark.

    blender -b --factory-startup --python scripts/blender/shop_art.py -- <stage_dir> [names...]
"""

import json
import math
import os
import sys

import addon_utils
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
STAGE = argv[0]
ONLY = set(argv[1:])


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable("io_curve_svg")


def hexc(s):
    """An sRGB '#rrggbb' as the linear colour Blender wants."""
    out = []
    for i in (1, 3, 5):
        c = int(s[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def mat(name, colour, rough=0.45, metal=0.0, trans=0.0, ior=1.45, clear=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*(hexc(colour) if isinstance(colour, str) else colour), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["IOR"].default_value = ior
    b.inputs["Transmission Weight"].default_value = trans
    b.inputs["Coat Weight"].default_value = clear
    b.inputs["Coat Roughness"].default_value = 0.08
    return m


def grain(m, scale, strength):
    """Fine bump: rubber stipple, bread, cardboard."""
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 6
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.02
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], nt.nodes["Principled BSDF"].inputs["Normal"])
    return m


def link(ob):
    bpy.context.collection.objects.link(ob)
    return ob


def side(name, loops, depth, m, bevel=0.012, y=0.0):
    """Polygons in (x, z) pushed out along y: the way a gun's parts are cut. Later loops are holes."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "2D"
    cu.fill_mode = "BOTH"
    cu.extrude = max(depth / 2 - bevel, 0.001)
    cu.bevel_depth = bevel
    cu.bevel_resolution = 3
    if loops and isinstance(loops[0][0], (int, float)):
        loops = [loops]
    for pts in loops:
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        for p, (x, z) in zip(sp.points, pts):
            p.co = (x, z, 0, 1)
        sp.use_cyclic_u = True
    cu.materials.append(m)
    ob = link(bpy.data.objects.new(name, cu))
    ob.rotation_euler = (math.pi / 2, 0, 0)
    ob.location.y = y
    return ob


def flat(name, loops, depth, m, z=0.0, bevel=0.01):
    """Polygons in (x, y) lying flat, pushed up along z."""
    ob = side(name, loops, depth, m, bevel)
    ob.rotation_euler = (0, 0, 0)
    ob.location = (0, 0, z)
    return ob


def ring(cx, cz, r, n=28, a0=0.0, a1=2 * math.pi):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cz + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n)]


def rounded(x0, z0, x1, z1, r, n=6):
    pts = []
    for cx, cz, a in ((x1 - r, z1 - r, 0), (x0 + r, z1 - r, 90), (x0 + r, z0 + r, 180), (x1 - r, z0 + r, 270)):
        for i in range(n + 1):
            t = math.radians(a + 90 * i / n)
            pts.append((cx + r * math.cos(t), cz + r * math.sin(t)))
    return pts


def lathe(name, profile, m, segments=96, at=(0, 0, 0)):
    verts, faces = [], []
    n = len(profile)
    for i in range(segments):
        a = 2 * math.pi * i / segments
        for r, z in profile:
            verts.append((r * math.cos(a), r * math.sin(a), z))
    for i in range(segments):
        j = (i + 1) % segments
        for k in range(n - 1):
            faces.append((i * n + k, j * n + k, j * n + k + 1, i * n + k + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(m)
    ob = link(bpy.data.objects.new(name, me))
    ob.location = at
    return ob


def box(name, size, at, m, bevel=0.02, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    ob.data.materials.append(m)
    if bevel:
        b = ob.modifiers.new("b", "BEVEL")
        b.width = bevel
        b.segments = 3
    bpy.ops.object.shade_smooth()
    ob.data.polygons.foreach_set("use_smooth", [True] * len(ob.data.polygons))
    return ob


def group(*obs, rot=(0, 0, 0), at=(0, 0, 0), scale=1.0):
    g = link(bpy.data.objects.new("group", None))
    for ob in obs:
        ob.parent = g
    g.rotation_euler = rot
    g.location = at
    g.scale = (scale, scale, scale)
    return g


def text(body, size, m, at, rot=(math.pi / 2, 0, 0), depth=0.004, align="CENTER"):
    cu = bpy.data.curves.new("t", "FONT")
    cu.body = body
    cu.size = size
    cu.extrude = depth
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.materials.append(m)
    ob = link(bpy.data.objects.new("t", cu))
    ob.location = at
    ob.rotation_euler = rot
    return ob


def stage(target, distance, height, lens=80, key=300, fill=60, rim=220, world=0.42, warm=(1, 0.96, 0.9)):
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.92, 0.95, 1.0, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = world
    bpy.context.scene.world = w
    for name, loc, power, size, colour in (
        ("key", (3.5, -5, 6), key, 5, warm),
        ("fill", (-6, -3, 1.5), fill, 7, (0.82, 0.9, 1)),
        ("rim", (-1.5, 6.5, 4.5), rim, 4, (1, 1, 1)),
    ):
        d = bpy.data.lights.new(name, "AREA")
        d.energy, d.size, d.color = power, size, colour
        ob = link(bpy.data.objects.new(name, d))
        ob.location = loc
        ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    cam = bpy.data.cameras.new("cam")
    cam.lens = lens
    ob = link(bpy.data.objects.new("cam", cam))
    ob.location = (0, -distance, height)
    ob.rotation_euler = (Vector(target) - Vector(ob.location)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob


def render(name, size=640, samples=72):
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.samples = samples
    s.cycles.device = "CPU"
    s.cycles.use_denoising = True
    s.render.film_transparent = True
    s.render.resolution_x = s.render.resolution_y = size
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGBA"
    s.view_settings.view_transform = "Standard"
    s.render.filepath = os.path.join(STAGE, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name, flush=True)


# ---- the guns ------------------------------------------------------------------------------


def pistol():
    steel = mat("steel", "#c3c7cf", rough=0.3, metal=1)
    dark = mat("dark", "#3a3e46", rough=0.4, metal=0.9)
    grip = grain(mat("grip", "#5b3a22", rough=0.62), 420, 0.5)
    gold = mat("gold", "#c79a3b", rough=0.3, metal=1)
    parts = [
        # The long, flat-sided slide of a big-bore pistol.
        side("slide", [(-1.42, 0.68), (-1.42, 0.3), (1.02, 0.3), (1.08, 0.46), (1.08, 0.66), (1.0, 0.76), (-1.34, 0.76)], 0.34, steel, 0.018),
        side("barrel_top", [(-1.42, 0.82), (-1.42, 0.74), (0.2, 0.74), (0.2, 0.82)], 0.12, steel, 0.012),
        side("port", rounded(0.02, 0.5, 0.56, 0.7, 0.03), 0.02, dark, 0.004, y=-0.172),
        side("frame", [(-1.1, 0.3), (1.05, 0.3), (1.09, 0.08), (0.66, 0.02), (0.2, 0.02), (-0.08, 0.16), (-1.1, 0.16)], 0.3, dark, 0.016),
        side("guard", [ring(-0.02, -0.02, 0.33, 30), ring(-0.02, -0.02, 0.255, 30)], 0.12, dark, 0.008),
        side("trigger", [(-0.02, 0.1), (0.05, 0.1), (0.02, -0.06), (-0.07, -0.16), (-0.1, -0.13), (-0.03, -0.03)], 0.07, gold, 0.008),
        side("grip", [(0.3, 0.08), (1.06, 0.08), (1.1, -0.08), (0.86, -1.22), (0.32, -1.22), (0.2, -1.1), (0.34, -0.2)], 0.3, grip, 0.03),
        side("base", [(0.3, -1.2), (0.88, -1.2), (0.86, -1.3), (0.32, -1.3)], 0.32, steel, 0.012),
        side("hammer", [(1.04, 0.5), (1.26, 0.72), (1.32, 0.64), (1.08, 0.34)], 0.09, dark, 0.008),
        side("front_sight", [(-1.32, 0.82), (-1.3, 0.94), (-1.18, 0.94), (-1.14, 0.82)], 0.06, dark, 0.004),
        side("rear_sight", [(0.82, 0.76), (0.82, 0.92), (1.02, 0.92), (1.02, 0.76)], 0.14, dark, 0.006),
    ]
    for i in range(9):
        x = 0.62 + i * 0.045
        parts.append(side("serr", [(x, 0.36), (x + 0.018, 0.36), (x + 0.03, 0.72), (x + 0.012, 0.72)], 0.01, dark, 0.002, y=-0.172))
    for x, z in ((0.5, -0.1), (0.62, -1.02)):
        parts.append(side("screw", ring(x, z, 0.05, 16), 0.02, gold, 0.006, y=-0.155))
    group(*parts, rot=(0, math.radians(-5), math.radians(-22)), at=(0, 0, 0.1))
    stage((0, 0, 0.1), 12, 1.9, lens=95)


def rifle():
    black = mat("black", "#33373e", rough=0.44, metal=0.8)
    tan = grain(mat("tan", "#a48a60", rough=0.68), 300, 0.25)
    steel = mat("steel", "#6f737b", rough=0.35, metal=1)
    gold = mat("gold", "#c79a3b", rough=0.3, metal=1)
    parts = [
        side("receiver", [(-0.75, 0.24), (1.0, 0.24), (1.12, 0.14), (1.12, -0.1), (0.1, -0.16), (-0.75, -0.16)], 0.24, black, 0.015),
        side("rail", [(-1.9, 0.33), (1.0, 0.33), (1.0, 0.24), (-1.9, 0.24)], 0.16, black, 0.008),
        side("handguard", [(-1.95, 0.24), (-0.72, 0.24), (-0.72, -0.14), (-1.84, -0.14), (-1.95, -0.06)], 0.28, tan, 0.02),
        side("barrel", [(-3.0, 0.1), (-1.9, 0.1), (-1.9, 0.0), (-3.0, 0.0)], 0.1, steel, 0.02),
        side("brake", [(-3.34, 0.14), (-2.96, 0.14), (-2.96, -0.04), (-3.34, -0.04)], 0.16, black, 0.012),
        side("front_sight", [(-1.82, 0.33), (-1.82, 0.6), (-1.72, 0.6), (-1.66, 0.33)], 0.08, black, 0.006),
        side("rear_sight", [(0.72, 0.33), (0.72, 0.56), (0.92, 0.56), (0.96, 0.33)], 0.12, black, 0.006),
        side("charge", [(0.96, 0.24), (0.96, 0.16), (1.22, 0.16), (1.22, 0.24)], 0.34, steel, 0.01),
        side("grip", [(0.34, -0.1), (0.8, -0.1), (0.72, -0.9), (0.42, -0.94), (0.26, -0.82)], 0.24, tan, 0.03),
        side("guard", [ring(0.06, -0.2, 0.2, 26, math.pi, 2 * math.pi) + [(0.26, -0.1), (-0.14, -0.1)], ring(0.06, -0.2, 0.14, 26, math.pi, 2 * math.pi) + [(0.2, -0.14), (-0.08, -0.14)]], 0.08, black, 0.006),
        side("trigger", [(0.08, -0.12), (0.14, -0.12), (0.12, -0.26), (0.05, -0.3), (0.03, -0.27), (0.08, -0.22)], 0.05, gold, 0.006),
        side("mag", [(-0.42, -0.14), (0.0, -0.14), (-0.06, -0.62), (-0.26, -1.28), (-0.66, -1.2), (-0.5, -0.62)], 0.2, black, 0.02),
        side("buffer", [(1.1, 0.14), (1.9, 0.14), (1.9, -0.06), (1.1, -0.06)], 0.14, black, 0.01),
        side("stock", [(1.55, 0.26), (2.45, 0.24), (2.56, 0.16), (2.56, -0.7), (2.34, -0.72), (1.95, -0.14), (1.55, -0.12)], 0.2, tan, 0.03),
        side("butt", [(2.54, 0.22), (2.64, 0.22), (2.64, -0.72), (2.54, -0.72)], 0.22, black, 0.012),
    ]
    for i in range(6):
        x = -1.78 + i * 0.17
        parts.append(side("slot", rounded(x, -0.02, x + 0.1, 0.13, 0.02), 0.012, black, 0.002, y=-0.145))
    group(*parts, rot=(0, math.radians(-3), math.radians(-14)), at=(0.2, 0, 0))
    stage((0.1, 0, -0.1), 26, 3.4, lens=95)


def cartridge(at, brass, tip, scale=1.0, tilt=(0, 0, 0), long=False):
    h = 1.0 if long else 0.62
    case = [(0.0, 0.0), (0.2, 0.0), (0.2, 0.05), (0.17, 0.07), (0.2, 0.1), (0.2, h * 0.7), (0.15 if long else 0.2, h * 0.84), (0.13 if long else 0.19, h)]
    nose = [(0.13 if long else 0.19, h), (0.125 if long else 0.18, h + 0.1), (0.09 if long else 0.14, h + (0.36 if long else 0.26)), (0.02, h + (0.52 if long else 0.34)), (0.0, h + (0.53 if long else 0.345))]
    a = lathe("case", case, brass, 48)
    b = lathe("nose", nose, tip, 48)
    return group(a, b, at=at, rot=tilt, scale=scale)


def ammo_box():
    card = grain(mat("card", "#1a2a44", rough=0.72), 180, 0.12)
    band = mat("band", "#c43a2c", rough=0.6)
    ink = mat("ink", "#f4f1e6", rough=0.5)
    brass = mat("brass", "#d6a94a", rough=0.26, metal=1)
    tip = mat("tip", "#b5693b", rough=0.3, metal=1)
    body = box("box", (1.9, 1.2, 1.15), (0, 0, 0.575), card, 0.04)
    b1 = box("band", (1.92, 1.22, 0.32), (0, 0, 0.66), band, 0.01)
    t1 = text(".50 CAL", 0.25, ink, (0, -0.617, 0.66), depth=0.003)
    t2 = text("28 ROUNDS", 0.11, ink, (0, -0.607, 0.3), depth=0.002)
    group(body, b1, t1, t2, rot=(0, 0, math.radians(-24)))
    cartridge((1.3, -0.72, 0), brass, tip, 1.22)
    cartridge((1.82, -0.42, 0), brass, tip, 1.22)
    cartridge((1.25, -1.15, 0.2), brass, tip, 1.22, tilt=(math.radians(90), 0, math.radians(68)))
    stage((0.45, 0, 0.55), 12, 3.6, lens=85)


def ammo_can():
    olive = grain(mat("olive", "#4f5a33", rough=0.58, metal=0.25), 160, 0.08)
    dark = mat("dark", "#2c3220", rough=0.5, metal=0.4)
    steel = mat("steel", "#8d9096", rough=0.34, metal=1)
    ink = mat("ink", "#e7c94c", rough=0.6)
    brass = mat("brass", "#d6a94a", rough=0.26, metal=1)
    tip = mat("tip", "#8b5a35", rough=0.32, metal=1)
    body = box("can", (2.2, 1.1, 1.3), (0, 0, 0.65), olive, 0.03)
    lid = box("lid", (2.28, 1.18, 0.24), (0, 0, 1.38), dark, 0.03)
    latch = box("latch", (0.34, 0.08, 0.42), (0.96, -0.6, 1.12), steel, 0.015)
    handle = side("handle", [ring(0, 1.52, 0.42, 22, 0, math.pi) + ring(0, 1.52, 0.34, 22, math.pi, 0)], 0.1, steel, 0.012)
    t1 = text("RIFLE ROUNDS", 0.17, ink, (-0.08, -0.556, 0.82), depth=0.003)
    t2 = text("90 CT", 0.14, ink, (-0.08, -0.556, 0.52), depth=0.003)
    group(body, lid, latch, handle, t1, t2, rot=(0, 0, math.radians(-24)))
    for i, (x, y) in enumerate(((1.42, -0.86), (1.76, -0.52))):
        cartridge((x, y, 0), brass, tip, 1.06, long=True)
    cartridge((1.1, -1.25, 0.14), brass, tip, 1.06, tilt=(math.radians(90), 0, math.radians(72)), long=True)
    stage((0.3, 0, 0.72), 12.5, 3.4, lens=85)


def licence():
    img = bpy.data.images.load(os.path.join(STAGE, "licence-face.png"))
    face = mat("face", "#ffffff", rough=0.28, clear=0.6)
    nt = face.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    edge = mat("edge", "#dfe3ea", rough=0.35)
    w, h = 1.71, 1.08
    card = flat("card", rounded(-w, -h, w, h, 0.14, 10), 0.05, edge, 0.0, 0.008)
    me = bpy.data.meshes.new("front")
    me.from_pydata([(-w + 0.012, -h + 0.012, 0.0265), (w - 0.012, -h + 0.012, 0.0265), (w - 0.012, h - 0.012, 0.0265), (-w + 0.012, h - 0.012, 0.0265)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for li, c in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[li].uv = c
    me.materials.append(face)
    front = link(bpy.data.objects.new("front", me))
    group(card, front, rot=(math.radians(62), math.radians(-5), math.radians(-14)))
    stage((0, 0, 0), 11.5, 0.9, lens=85, key=210, rim=160)


# ---- Sunny's -------------------------------------------------------------------------------


def water():
    plastic = mat("plastic", "#dceffc", rough=0.08, trans=0.92, ior=1.34)
    liquid = mat("liquid", "#7cc4f0", rough=0.03, trans=0.95, ior=1.33)
    cap = mat("cap", "#1d6fd1", rough=0.32)
    label = mat("label", "#1466c4", rough=0.42, clear=0.3)
    white = mat("white", "#f5f8ff", rough=0.45)
    prof = [(0.0, 0.0), (0.46, 0.0), (0.52, 0.06), (0.54, 0.2)]
    for i in range(7):
        z = 0.24 + i * 0.09
        prof += [(0.54, z), (0.5, z + 0.045)]
    prof += [(0.54, 0.9), (0.54, 1.72), (0.5, 1.98), (0.3, 2.34), (0.2, 2.5), (0.2, 2.62)]
    lathe("bottle", prof, plastic)
    lathe("water", [(0.0, 0.03), (0.5, 0.05), (0.5, 1.9), (0.0, 1.9)], liquid)
    lathe("label", [(0.548, 1.0), (0.548, 1.66)], label)
    lathe("stripe", [(0.552, 1.26), (0.552, 1.4)], white)
    lathe("cap", [(0.0, 2.86), (0.2, 2.86), (0.235, 2.82), (0.235, 2.6), (0.0, 2.6)][::-1], cap)
    lathe("collar", [(0.26, 2.56), (0.26, 2.6)], cap)
    stage((0, 0, 1.42), 12, 1.6, lens=85, world=0.7)


def sandwich():
    tri = [(-1.25, -0.82), (1.25, -0.82), (0.0, 1.05)]

    def corners(pts, r):
        out = []
        n = len(pts)
        for i, p in enumerate(pts):
            a, b = Vector(pts[i - 1]) - Vector(p), Vector(pts[(i + 1) % n]) - Vector(p)
            a.normalize(), b.normalize()
            for t in range(6):
                k = t / 5
                q = (a * (1 - k) + b * k).normalized()
                out.append((p[0] + q.x * r * (1 - math.sin(k * math.pi) * 0.3), p[1] + q.y * r * (1 - math.sin(k * math.pi) * 0.3)))
        return out

    bread = grain(mat("bread", "#e0b878", rough=0.86), 70, 0.9)
    crust = grain(mat("crust", "#a56a2c", rough=0.7), 90, 0.5)
    ham = mat("ham", "#df8c8a", rough=0.45)
    cheese = mat("cheese", "#f2bf3b", rough=0.4)
    lettuce = grain(mat("lettuce", "#6fae2e", rough=0.5), 40, 0.4)
    tomato = mat("tomato", "#cf3226", rough=0.28)
    z = 0.0
    obs = []
    outer = corners(tri, 0.28)
    inner = [(x * 0.96, y * 0.96) for x, y in outer]
    obs.append(flat("b1", outer, 0.3, crust, z + 0.15, 0.06))
    obs.append(flat("b1i", inner, 0.31, bread, z + 0.15, 0.05))
    z += 0.3
    # Ruffled lettuce: the outline waves in and out and up and down.
    n = 160
    verts = [(0, 0, z + 0.03)]
    faces = []
    for i in range(n):
        t = i / n * len(outer)
        a = outer[int(t) % len(outer)]
        b = outer[(int(t) + 1) % len(outer)]
        f = t - int(t)
        x, y = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        k = 1.11 + 0.05 * math.sin(i * 1.3)
        verts.append((x * k, y * k, z + 0.04 + 0.05 * math.sin(i * 0.9)))
    for i in range(n):
        faces.append((0, i + 1, (i + 1) % n + 1))
    me = bpy.data.meshes.new("lettuce")
    me.from_pydata(verts, [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(lettuce)
    lf = link(bpy.data.objects.new("lettuce", me))
    s = lf.modifiers.new("s", "SOLIDIFY")
    s.thickness = 0.03
    obs.append(lf)
    z += 0.08
    for x, y in ((-0.5, -0.32), (0.5, -0.32), (0.0, 0.42)):
        d = flat("tomato", ring(x, y, 0.42, 36), 0.09, tomato, z + 0.045, 0.03)
        obs.append(d)
    z += 0.09
    obs.append(flat("ham", [(x * 1.03, y * 1.03) for x, y in outer], 0.08, ham, z + 0.04, 0.03))
    z += 0.08
    obs.append(flat("cheese", [(x * 1.07, y * 1.07 - 0.02) for x, y in [(-1.25, -0.9), (1.25, -0.9), (0.0, 1.14)]], 0.05, cheese, z + 0.025, 0.012))
    z += 0.05
    obs.append(flat("b2", outer, 0.3, crust, z + 0.15, 0.06))
    obs.append(flat("b2i", inner, 0.31, bread, z + 0.15, 0.05))
    group(*obs, rot=(math.radians(14), 0, math.radians(202)), at=(0, 0, 0.6))
    stage((0, 0, 0.8), 13, 5.2, lens=85)


def meal():
    bowl = mat("bowl", "#f3efe6", rough=0.2, clear=0.5)
    rim = mat("rim", "#20517f", rough=0.25, clear=0.4)
    stew = grain(mat("stew", "#a4561c", rough=0.34), 14, 0.5)
    carrot = mat("carrot", "#ee7a1a", rough=0.42)
    potato = mat("potato", "#e6cf8f", rough=0.62)
    beef = grain(mat("beef", "#5e3018", rough=0.6), 30, 0.7)
    pea = mat("pea", "#5da22a", rough=0.34)
    herb = mat("herb", "#3e7f26", rough=0.5)
    lathe("bowl", [(0, 0), (0.62, 0), (0.7, 0.04), (0.74, 0.12), (1.18, 0.74), (1.5, 1.08), (1.56, 1.14), (1.5, 1.14), (1.14, 0.8), (0.72, 0.26), (0, 0.2)], bowl)
    lathe("rimline", [(1.5, 1.09), (1.558, 1.145), (1.52, 1.15)], rim)
    lathe("stew", [(0, 0.86), (1.32, 0.9)], stew)
    place = [(-0.6, -0.2), (0.3, -0.55), (0.72, 0.1), (-0.15, 0.45), (-0.82, 0.42), (0.42, 0.72)]
    for i, (x, y) in enumerate(place):
        if i % 3 == 0:
            d = flat("carrot", ring(0, 0, 0.21, 22), 0.08, carrot, 0, 0.03)
            d.location = (x, y, 0.98)
            d.rotation_euler = (0.3, 0.2 * i, i)
        elif i % 3 == 1:
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=0.25, location=(x, y, 0.96))
            o = bpy.context.object
            o.scale = (1, 0.82, 0.62)
            o.data.materials.append(potato)
            bpy.ops.object.shade_smooth()
        else:
            box("beef", (0.36, 0.3, 0.2), (x, y, 0.98), beef, 0.06, rot=(0.2, 0.1, i))
    for i in range(16):
        a, r = i * 2.4, 0.3 + (i % 5) * 0.2
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=0.065, location=(r * math.cos(a), r * math.sin(a), 0.96))
        bpy.context.object.data.materials.append(pea)
        bpy.ops.object.shade_smooth()
    for i in range(9):
        a, r = i * 1.7, 0.2 + (i % 4) * 0.28
        box("herb", (0.09, 0.03, 0.012), (r * math.cos(a), r * math.sin(a), 1.09), herb, 0, rot=(0, 0, i * 0.9))
    stage((0, 0, 0.72), 11.5, 7, lens=85)


# ---- medallions ----------------------------------------------------------------------------


def import_svg(path):
    before = set(bpy.data.objects)
    bpy.ops.import_curve.svg(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def fit(obs, half):
    """Centres imported curves on the origin and scales the largest side to 2 × half."""
    bpy.context.view_layer.update()
    lo, hi = Vector((1e9, 1e9)), Vector((-1e9, -1e9))
    for o in obs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo.x, lo.y = min(lo.x, w.x), min(lo.y, w.y)
            hi.x, hi.y = max(hi.x, w.x), max(hi.y, w.y)
    size = max(hi.x - lo.x, hi.y - lo.y)
    k = 2 * half / size
    mid = (lo + hi) / 2
    return k, mid


def raised(obs, m, depth, bevel, half, z):
    k, mid = fit(obs, half)
    for o in obs:
        o.data.dimensions = "2D"
        o.data.fill_mode = "BOTH"
        o.data.extrude = depth / k / 2
        o.data.bevel_depth = bevel / k
        o.data.bevel_resolution = 3
        o.data.materials.clear()
        o.data.materials.append(m)
        o.scale = (o.scale.x * k, o.scale.y * k, o.scale.z * k)
        o.location = (o.location.x * k - mid.x * k, o.location.y * k - mid.y * k, z)
    return obs


TURN = (math.radians(74), 0, math.radians(-16))


def medallion(icon, enamel, metal, icon_half=0.66):
    base = mat("metal", metal, rough=0.28, metal=1)
    glaze = mat("enamel", enamel, rough=0.3, clear=0.25)
    top = mat("icon", metal, rough=0.22, metal=1)
    rim = lathe("rim", [(0, -0.14), (1.0, -0.14), (1.05, -0.1), (1.05, 0.1), (1.0, 0.14), (0.9, 0.14), (0.86, 0.08), (0.86, 0.05), (0, 0.05)], base, 160)
    disc = lathe("disc", [(0, 0.062), (0.87, 0.062)], glaze, 160)
    studs = []
    for i in range(32):
        a = 2 * math.pi * i / 32
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.018, location=(0.955 * math.cos(a), 0.955 * math.sin(a), 0.14))
        bpy.context.object.data.materials.append(base)
        bpy.ops.object.shade_smooth()
        studs.append(bpy.context.object)
    obs = raised(import_svg(icon), top, 0.07, 0.012, icon_half, 0.1)
    group(rim, disc, *studs, *obs, rot=TURN)
    stage((0, 0, 0), 12, 0.9, lens=90, key=230, rim=300, world=0.22)


def coin():
    """USDC's own mark, as a heavy coin: the blue disc, with the $ and the arcs standing proud."""
    blue = mat("blue", "#2775ca", rough=0.26, metal=0.15, clear=1)
    edge = mat("edge", "#1e5fa8", rough=0.3, metal=0.5)
    white = mat("white", "#ffffff", rough=0.22, metal=0.1, clear=0.4)
    body = lathe("body", [(0, -0.12), (0.98, -0.12), (1.0, -0.1), (1.0, 0.1), (0.98, 0.12), (0, 0.12)], edge, 192)
    face = lathe("face", [(0, 0.1205), (0.985, 0.1205)], blue, 192)
    obs = raised(import_svg(os.path.join(STAGE, "usdc-white.svg")), white, 0.05, 0.008, 0.815, 0.135)
    group(body, face, *obs, rot=(math.radians(72), math.radians(-6), math.radians(-20)))
    stage((0, 0, 0), 12, 0.8, lens=90, key=260, rim=320, world=0.6)


WANT = json.load(open(os.path.join(STAGE, "medallions.json")))
JOBS = {"pistol": pistol, "rifle": rifle, "pistol_rounds": ammo_box, "rifle_rounds": ammo_can, "licence": licence, "water": water, "sandwich": sandwich, "meal": meal, "usdc": coin}
for name, build in JOBS.items():
    if ONLY and name not in ONLY:
        continue
    clear()
    build()
    render(name)
for name, spec in WANT.items():
    if ONLY and name not in ONLY:
        continue
    clear()
    medallion(os.path.join(STAGE, f"icon-{name}.svg"), spec["enamel"], spec["metal"], spec.get("half", 0.62))
    render(f"m-{name}", 420)
print("BUILT shop art")
