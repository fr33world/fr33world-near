"""
Converts a Microsoft Rocketbox avatar (MIT) into the game's two character parts:

    blender -b --factory-startup --python scripts/blender/convert_rocketbox.py -- \
        <avatar.fbx> <out_dir> <id> [outfit,face]

writes <out_dir>/rb_<id>_outfit[.lod1|.lod2].glb (the body material: clothes, hands, neck,
and on a uniform its belt and holsters)
and <out_dir>/rb_<id>_face[.lod1|.lod2].glb (the head and its cut-out hair and lashes), each
skinned to the full skeleton, plus <out_dir>/rb_<id>.json (which bones exist, the rig's hip
height). Normally run through scripts/assets/rocketbox.mjs.

The game puts any face on any outfit of the same body: both parts carry the whole skeleton
and the client binds the face to the outfit's bones by name. Bones are renamed to the
Mixamo names the game's animation code uses (the clips themselves are retargeted onto this
skeleton by scripts/assets/retarget-rocketbox.mjs). Scale and rotation are applied, so the
rig is in metres with unit scale; specular maps are dropped (constant roughness instead);
textures are 1024 px (512 and 256 for the lighter levels).
"""

import json
import os
import sys

import bmesh
import bpy

# Rocketbox (3ds Max Biped) → Mixamo names (the game's clips and code use these).
BONES = {
    "Bip01 Pelvis": "Hips",
    "Bip01 Spine": "Spine",
    "Bip01 Spine1": "Spine1",
    "Bip01 Spine2": "Spine2",
    "Bip01 Neck": "Neck",
    "Bip01 Head": "Head",
}
for side, name in (("L", "Left"), ("R", "Right")):
    BONES.update(
        {
            f"Bip01 {side} Clavicle": f"{name}Shoulder",
            f"Bip01 {side} UpperArm": f"{name}Arm",
            f"Bip01 {side} Forearm": f"{name}ForeArm",
            f"Bip01 {side} Hand": f"{name}Hand",
            f"Bip01 {side} Thigh": f"{name}UpLeg",
            f"Bip01 {side} Calf": f"{name}Leg",
            f"Bip01 {side} Foot": f"{name}Foot",
            f"Bip01 {side} Toe0": f"{name}ToeBase",
        }
    )
    for finger, fname in enumerate(("Thumb", "Index", "Middle", "Ring", "Pinky")):
        for joint, suffix in enumerate(("", "1", "2")):
            BONES[f"Bip01 {side} Finger{finger}{suffix}"] = f"{name}Hand{fname}{joint + 1}"

LEVELS = [("", 1.0, 1024), (".lod1", 0.5, 512), (".lod2", 0.22, 256)]


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    fbx, out_dir, ident = args[0], args[1], args[2]
    # A uniform needs only its outfit: the wearer keeps their own face.
    wanted = args[3].split(",") if len(args) > 3 else ["outfit", "face"]
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    mesh = next(o for o in bpy.data.objects if o.type == "MESH")

    # The FBX's own take keys the rig's object scale (0.01) and rotation: evaluated at export it
    # put them back over the applied transform. No animation comes from here.
    for o in bpy.data.objects:
        o.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)

    # Metres, unit scale, no rotation, the rig's origin on the ground (the hips joint carries
    # the hip height, as on the Mixamo rig the clips and the game code expect).
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()

    for bone in arm.data.bones:
        if bone.name in BONES:
            bone.name = f"mixamorig:{BONES[bone.name]}"
    arm.name = arm.data.name = "rocketbox"

    tidy_materials()
    # The glTF exporter undoes its own temporary changes after each export: mark this state as
    # a step, or it rolls back to the import (0.01 scale, old names) too.
    bpy.ops.ed.undo_push(message="prepared")
    hips = arm.matrix_world @ arm.data.bones["mixamorig:Hips"].head_local
    meta = {
        "id": ident,
        "hipsHeight": round(hips.z, 4),
        "bones": [b.name for b in arm.data.bones],
    }

    for part, keep in (("outfit", ("_body", "_equipment")), ("face", ("_head", "_opacity"))):
        if part not in wanted:
            continue
        for suffix, ratio, size in LEVELS:
            export_part(arm, mesh, keep, ratio, size, os.path.join(out_dir, f"rb_{ident}_{part}{suffix}.glb"))
    with open(os.path.join(out_dir, f"rb_{ident}.json"), "w") as f:
        json.dump(meta, f)
    print("CONVERTED", ident)


def tidy_materials():
    """Constant roughness instead of the specular maps; the cut-out hair alpha-tested."""
    for m in bpy.data.materials:
        nt = m.node_tree
        if not nt:
            continue
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        for socket in ("Specular IOR Level", "Roughness", "Metallic"):
            for link in list(bsdf.inputs[socket].links):
                nt.links.remove(link)
        bsdf.inputs["Roughness"].default_value = 0.62
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Specular IOR Level"].default_value = 0.35
        for n in list(nt.nodes):
            if n.type == "TEX_IMAGE" and n.image and n.image.filepath.endswith("_specular.tga"):
                nt.nodes.remove(n)
        if m.name.endswith("_opacity"):
            tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None)
            if tex:
                nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
            m.blend_method = "CLIP"
            m.alpha_threshold = 0.5


def export_part(arm, mesh, keep, ratio, size, path):
    """One part at one level of detail: a copy of the mesh with only `keep` materials."""
    part = mesh.copy()
    part.data = mesh.data.copy()
    bpy.context.collection.objects.link(part)
    bm = bmesh.new()
    bm.from_mesh(part.data)
    mats = part.data.materials
    drop = [f for f in bm.faces if not any(mats[f.material_index].name.endswith(k) for k in keep)]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bm.to_mesh(part.data)
    bm.free()
    if ratio < 1:
        mod = part.modifiers.new("decimate", "DECIMATE")
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        # Keep the decimate ahead of the armature in the stack.
        bpy.context.view_layer.objects.active = part
        while part.modifiers.find("decimate") > 0:
            bpy.ops.object.modifier_move_up(modifier="decimate")
        bpy.ops.object.modifier_apply(modifier="decimate")
    # Textures at this level's size (copies, so the next level starts from the originals).
    used = set()
    for slot in part.material_slots:
        if slot.material and any(slot.material.name.endswith(k) for k in keep):
            used.add(slot.material)
    originals = {}
    for m in used:
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                img = n.image
                originals[n] = img
                small = img.copy()
                small.scale(size, size)
                small.file_format = "PNG" if m.name.endswith("_opacity") else "JPEG"
                n.image = small
    bpy.ops.ed.undo_push(message="part")
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    part.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=path,
        use_selection=True,
        export_format="GLB",
        export_animations=False,
        export_image_format="AUTO",
        export_jpeg_quality=86,
        export_skins=True,
        export_all_influences=False,
        export_def_bones=False,
    )
    for n, img in originals.items():
        small = n.image
        n.image = img
        bpy.data.images.remove(small)
    bpy.data.objects.remove(part)


main()
