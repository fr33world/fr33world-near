"""
Packs Mixamo clips (FBX, "Without Skin", downloaded for our uploaded base character so they
share its rest pose) into one animation-only GLB on the `shared_humanoid_v1` skeleton.

    blender -b --factory-startup --python scripts/blender/convert_animations.py -- \
        <fbx_dir> <out.glb> [--only idle,walking,...] [--in-place walking,running,...]

Normally run through scripts/build-animations.mjs, which stages each pack's files.

Each file becomes one clip named after it in snake_case ("Walking.fbx" → "walking").
`--only` packs just the named clips (packs are split so the core one stays small).
`--in-place` strips horizontal hips motion from the named clips, for clips downloaded
without Mixamo's "In Place" box ticked. Raw FBX files stay out of git (Mixamo terms).

Each clip's report line gives its length and how far the hips travel (metres, glTF axes: +x
left of a character facing +z, +z forward), i.e. the ground speed the clip was authored at.
Ported from the earlier FreeWorld project (decision D-27).
"""

import math

import os
import re
import sys

import bpy


def snake(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def travel(arm, action):
    """Hips travel over the clip, measured in world space before any in-place stripping."""
    scene = bpy.context.scene
    hips = arm.pose.bones.get("mixamorig:Hips")
    start, end = int(action.frame_range[0]), int(action.frame_range[1])
    fps = scene.render.fps / scene.render.fps_base
    seconds = max(1e-6, (end - start) / fps)
    if hips is None:
        return f"seconds={seconds:.2f}"

    def at(frame):
        scene.frame_set(frame)
        return arm.matrix_world @ hips.head

    a, b = at(start), at(end)
    # The glTF exporter maps Blender (x, y, z) to (x, z, -y), and Mixamo clips walk toward -Y.
    fx, fz = b.x - a.x, -(b.y - a.y)
    speed = math.hypot(fx, fz) / seconds
    return f"seconds={seconds:.2f} travel_x={fx:.2f} travel_z={fz:.2f} speed={speed:.2f}"


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        raise SystemExit("usage: ... -- <fbx_dir> <out.glb> [--in-place a,b]")
    src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    in_place = set()
    only = None
    if "--only" in argv:
        only = {snake(n) for n in argv[argv.index("--only") + 1].split(",")}
    if "--in-place" in argv:
        in_place = {snake(n) for n in argv[argv.index("--in-place") + 1].split(",")}

    bpy.ops.wm.read_factory_settings(use_empty=True)
    files = sorted(
        f
        for f in os.listdir(src)
        if f.lower().endswith(".fbx") and (only is None or snake(os.path.splitext(f)[0]) in only)
    )
    if not files:
        raise SystemExit(f"no .fbx files in {src}")

    keeper = None
    for f in files:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=os.path.join(src, f), automatic_bone_orientation=False)
        new = set(bpy.data.objects) - before
        arm = next((o for o in new if o.type == "ARMATURE"), None)
        if arm is None or arm.animation_data is None or arm.animation_data.action is None:
            print(f"SKIP {f}: no armature animation")
            for o in new:
                bpy.data.objects.remove(o, do_unlink=True)
            continue
        action = arm.animation_data.action
        name = snake(os.path.splitext(f)[0])
        report = travel(arm, action)
        action.name = name
        action.use_fake_user = True
        if name in in_place:
            for fc in action.fcurves:
                # Hips location X and Z (Blender Y is forward after import): keep Y (height).
                if fc.data_path == 'pose.bones["mixamorig:Hips"].location' and fc.array_index in (0, 2):
                    first = fc.keyframe_points[0].co[1] if fc.keyframe_points else 0
                    for k in fc.keyframe_points:
                        k.co[1] = first
                        k.handle_left[1] = first
                        k.handle_right[1] = first
        if keeper is None:
            keeper = arm
            keeper.name = "shared_humanoid_v1"
        else:
            for o in new:
                bpy.data.objects.remove(o, do_unlink=True)
        # Meshes from a "With Skin" download are not wanted either.
        for o in list(bpy.data.objects):
            if o.type == "MESH":
                bpy.data.objects.remove(o, do_unlink=True)
        print(f"CLIP {name} {report}")

    if keeper is None:
        raise SystemExit("no usable clips")
    keeper.animation_data.action = None
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_anim_single_armature=True,
        export_force_sampling=True,
        export_skins=True,
        export_morph=False,
        export_yup=True,
    )
    print(f"BUILT {out}")


main()
