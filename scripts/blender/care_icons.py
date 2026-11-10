"""
Renders the bag's item pictures (shared CARE): a roll of gauze and a bottle of medicine, each on
a clear background, as PNGs for scripts/assets/care-icons.mjs to shrink.

    blender -b --factory-startup --python scripts/blender/care_icons.py -- <out_dir>
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, colour, rough=0.5, metal=0.0, transmission=0.0, ior=1.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*colour, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["IOR"].default_value = ior
    key = "Transmission Weight" if "Transmission Weight" in b.inputs else "Transmission"
    b.inputs[key].default_value = transmission
    return m


def weave(m, scale, strength):
    """A fine cloth weave on a material, as bump."""
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    coord = nt.nodes.new("ShaderNodeTexCoord")
    waves = []
    for axis, rot in ((0, 0.0), (1, math.pi / 2)):
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, rot)
        nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.inputs["Scale"].default_value = scale
        wave.inputs["Distortion"].default_value = 0.6
        nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
        waves.append(wave)
    mix = nt.nodes.new("ShaderNodeMath")
    mix.operation = "MULTIPLY"
    nt.links.new(waves[0].outputs["Fac"], mix.inputs[0])
    nt.links.new(waves[1].outputs["Fac"], mix.inputs[1])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.02
    nt.links.new(mix.outputs[0], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])


def mesh_object(name, verts, faces, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    me.materials.append(mat)
    return ob


def lathe(name, profile, mat, segments=96):
    """Spins (radius, height) around z."""
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
    return mesh_object(name, verts, faces, mat)


def gauze_roll():
    """A spiral of cloth seen end-on, its loose end falling away."""
    cloth = material("gauze", (0.97, 0.96, 0.92), rough=0.85)
    weave(cloth, 90, 0.5)
    r0, r1, half = 0.28, 1.0, 0.62
    turns = 14
    steps = 720
    thick = (r1 - r0) / turns * 0.97
    verts, faces = [], []
    for i in range(steps + 1):
        t = i / steps
        a = t * turns * 2 * math.pi
        r = r0 + (r1 - r0) * t
        c, s = math.cos(a), math.sin(a)
        for rr, z in ((r, -half), (r, half), (r + thick, half), (r + thick, -half)):
            # A little soft unevenness along the layers.
            wob = 0.012 * math.sin(a * 3.1) + 0.008 * math.sin(a * 7.3)
            verts.append((rr * c, (rr * s), z + wob))
    for i in range(steps):
        for k in range(4):
            a0, a1 = i * 4 + k, i * 4 + (k + 1) % 4
            b0, b1 = (i + 1) * 4 + k, (i + 1) * 4 + (k + 1) % 4
            faces.append((a0, b0, b1, a1))
    roll = mesh_object("roll", verts, faces, cloth)
    # The tail, curling from the outside of the roll.
    tail = []
    tf = []
    n = 34
    for i in range(n):
        t = i / (n - 1)
        x = 1.02 + 0.32 * t
        y = -0.02 - 0.2 * t - 0.75 * t * t
        wave = 0.05 * math.sin(t * 7)
        tail.append((x, y, -half + wave))
        tail.append((x, y, half + wave))
    for i in range(n - 1):
        tf.append((i * 2, (i + 1) * 2, (i + 1) * 2 + 1, i * 2 + 1))
    end = mesh_object("tail", tail, tf, cloth)
    mod = end.modifiers.new("solid", "SOLIDIFY")
    mod.thickness = 0.018
    group = bpy.data.objects.new("gauze", None)
    bpy.context.collection.objects.link(group)
    for ob in (roll, end):
        ob.parent = group
    group.rotation_euler = (math.radians(58), 0, math.radians(-32))
    return group


def pill(x, y, z, turn, tilt=0.0):
    half = material("cap_red", (0.82, 0.08, 0.06), rough=0.25)
    other = material("cap_white", (0.95, 0.95, 0.93), rough=0.25)
    group = bpy.data.objects.new("pill", None)
    bpy.context.collection.objects.link(group)
    ar = 0.13
    for name, mat, z0, z1, sign in (("a", half, 0.0, 0.2, 1), ("b", other, -0.2, 0.0, -1)):
        prof = []
        for i in range(10):
            a = math.pi / 2 * i / 9
            prof.append((ar * math.cos(a), sign * (abs(z1 if sign > 0 else z0) + ar * math.sin(a))))
        prof = [(0.1301, 0.0)] + prof if sign > 0 else [(0.1301, 0.0)] + prof
        prof = prof if sign > 0 else list(reversed(prof))
        ob = lathe(name, prof, mat, 48)
        ob.parent = group
    group.location = (x, y, z)
    group.rotation_euler = (math.pi / 2, tilt, turn)


def bottle():
    amber = material("amber", (0.86, 0.33, 0.04), rough=0.12, transmission=0.82, ior=1.5)
    # The inside glows a little, or the glass reads black against nothing.
    amber.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.95, 0.42, 0.08, 1)
    body = [(0.0, 0.0), (0.56, 0.0), (0.62, 0.05), (0.64, 0.12), (0.64, 1.42), (0.6, 1.54), (0.5, 1.6), (0.46, 1.62), (0.46, 1.72)]
    lathe("glass", body, amber)
    white = material("cap", (0.94, 0.94, 0.92), rough=0.38)
    prof = [(0.0, 2.06), (0.5, 2.06), (0.56, 2.04), (0.58, 2.0), (0.58, 1.68), (0.0, 1.68)]
    cap = lathe("cap", list(reversed(prof)), white)
    # The ridges on the cap.
    bm = bmesh.new()
    n = 44
    for i in range(n):
        a = 2 * math.pi * i / n
        m = bmesh.ops.create_cube(bm, size=1)
        vs = m["verts"]
        for v in vs:
            v.co = Vector((v.co.x * 0.03, v.co.y * 0.05, v.co.z * 0.33))
        bmesh.ops.rotate(bm, verts=vs, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(a, 3, "Z"))
        bmesh.ops.translate(bm, verts=vs, vec=(0.585 * math.cos(a), 0.585 * math.sin(a), 1.86))
    me = bpy.data.meshes.new("ridges")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("ridges", me)
    bpy.context.collection.objects.link(ob)
    me.materials.append(white)
    # The label: white, a red cross, a teal band.
    w, h = 1024, 512
    img = bpy.data.images.new("label", w, h, alpha=False)
    px = [1.0] * (w * h * 4)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            cx, cy = abs(x - w * 0.25), abs(y - h * 0.55)
            r, g, b = 0.97, 0.97, 0.95
            if (cx < 34 and cy < 118) or (cy < 34 and cx < 118):
                r, g, b = 0.83, 0.07, 0.06
            if y < 64:
                r, g, b = 0.05, 0.42, 0.45
            px[i], px[i + 1], px[i + 2] = r, g, b
    img.pixels = px
    lab = material("label", (1, 1, 1), rough=0.45)
    nt = lab.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    verts, faces, uvs = [], [], []
    segs = 96
    z0, z1 = 0.3, 1.24
    for i in range(segs + 1):
        a = 2 * math.pi * i / segs
        for z in (z0, z1):
            verts.append((0.648 * math.cos(a), 0.648 * math.sin(a), z))
    for i in range(segs):
        faces.append((i * 2, (i + 1) * 2, (i + 1) * 2 + 1, i * 2 + 1))
    label = mesh_object("label", verts, faces, lab)
    uv = label.data.uv_layers.new(name="UVMap")
    for poly in label.data.polygons:
        for li in poly.loop_indices:
            v = label.data.loops[li].vertex_index
            uv.data[li].uv = ((v // 2) / segs, v % 2)
    # Turn the cross to face the camera.
    label.rotation_euler = (0, 0, math.radians(-172))
    pill(1.0, -0.42, 0.14, 0.5)
    pill(0.58, -0.86, 0.14, -0.7)


def light_and_camera(target, distance, height, lens=70):
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.97, 1.0, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.34
    bpy.context.scene.world = world
    for name, loc, power, size, colour in (
        ("key", (3, -4, 6), 260, 5, (1, 0.96, 0.9)),
        ("fill", (-5, -3, 2), 55, 7, (0.85, 0.92, 1)),
        ("rim", (-1, 6, 4), 150, 4, (1, 1, 1)),
    ):
        d = bpy.data.lights.new(name, "AREA")
        d.energy, d.size, d.color = power, size, colour
        ob = bpy.data.objects.new(name, d)
        ob.location = loc
        ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.collection.objects.link(ob)
    cam = bpy.data.cameras.new("cam")
    cam.lens = lens
    ob = bpy.data.objects.new("cam", cam)
    ob.location = (0, -distance, height)
    ob.rotation_euler = (Vector(target) - Vector(ob.location)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(ob)
    bpy.context.scene.camera = ob


def render(out):
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.samples = 96
    s.cycles.device = "CPU"
    s.cycles.use_denoising = False
    s.render.film_transparent = True
    s.render.resolution_x = s.render.resolution_y = 640
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_mode = "RGBA"
    s.view_settings.view_transform = "Standard"
    s.render.filepath = out
    bpy.ops.render.render(write_still=True)


out_dir = sys.argv[sys.argv.index("--") + 1]
clear()
gauze_roll()
light_and_camera((0.12, 0, -0.1), 9, 3.2)
render(os.path.join(out_dir, "bandage.png"))
clear()
bottle()
light_and_camera((0.2, 0, 0.95), 10, 2.6)
render(os.path.join(out_dir, "medicine.png"))
print("BUILT care icons")
