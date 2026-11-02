#!/usr/bin/env node
/**
 * Lists each model's skins (joint counts) and the meshes bound to them, to check that an
 * optimisation pass kept characters animatable.   node scripts/assets/inspect-skins.mjs <glb...>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const file of process.argv.slice(2)) {
  const root = (await io.read(file)).getRoot();
  const skins = root.listSkins();
  const skinned = root
    .listNodes()
    .filter((n) => n.getSkin() && n.getMesh())
    .map((n) => `${n.getName()}→skin${skins.indexOf(n.getSkin())}`);
  console.log(
    `${file.split('/').pop()}: ${skins.length} skins (${skins.map((s) => s.listJoints().length).join(', ')} joints); bound: ${skinned.join(', ')}`,
  );
}
