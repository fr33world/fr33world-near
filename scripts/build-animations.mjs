#!/usr/bin/env node
/**
 * Builds the game's animation packs from the owner's Mixamo downloads in .raw/animations/
 * (raw FBX never goes in git: Mixamo terms). Each pack names its clips and the source file of
 * each, so files from different downloads can be renamed and combined. Needs Blender.
 *   node scripts/build-animations.mjs [pack ...]
 * Writes apps/client/public/assets/animations/<pack>.glb; record new packs in assets/registry.yaml.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const raw = join(root, '.raw/animations');
const out = join(root, 'apps/client/public/assets/animations');
const blender = process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';

/** pack → { clip name in the game: source file under .raw/animations } */
const PACKS = {
  // Chosen by the owner (2026-10-30): an upright standing idle, the talking gestures played
  // while a player holds the mic, and the jump.
  humanoid_social: {
    standing_idle: 'social/standing idle.fbx',
    talking: 'social/talking.fbx',
    jump: 'social/jump.fbx',
  },
  // The rifle (owner's Rifle 8-Way pack, 2026-10-28): fetched the first time anyone near holds
  // one. Aiming is the pack's own aiming idle, laid over the upper body.
  humanoid_rifle: {
    rifle_idle: 'rifle_pack/idle.fbx',
    rifle_walk: 'rifle_pack/walk forward.fbx',
    rifle_run: 'rifle_pack/run forward.fbx',
    rifle_walk_backward: 'rifle_pack/walk backward.fbx',
    rifle_run_backward: 'rifle_pack/run backward.fbx',
    rifle_strafe_left: 'rifle_pack/walk left.fbx',
    rifle_strafe_right: 'rifle_pack/walk right.fbx',
    rifle_aim: 'rifle_pack/idle aiming.fbx',
  },
  // Cars (owner's downloads, 2026-10-28): sitting at the wheel, and getting in and out at the
  // driver's door. Fetched with the first car a player gets into or sees driven.
  humanoid_vehicle: {
    driving: 'Driving.fbx',
    entering_car: 'Entering Car.fbx',
    exiting_car: 'Exiting Car.fbx',
  },
  // The owner's dances (2026-10-31), fetched with the first one danced near a player.
  humanoid_moves: {
    snake_hip_hop: 'Snake Hip Hop Dance.fbx',
    step_hip_hop: 'Step Hip Hop Dance.fbx',
  },
  // From the owner's earlier FreeWorld downloads: sitting on chairs.
  humanoid_rest: {
    sitting_idle: 'rest/Sitting Idle.fbx',
    stand_to_sit: 'rest/Stand To Sit.fbx',
    sit_to_stand: 'rest/Sit To Stand.fbx',
  },
  // Fetched when a player first holds a pistol. Strafe sides measured from the hips' travel.
  humanoid_pistol: {
    pistol_idle: 'pistol_pack/pistol idle.fbx',
    pistol_walk: 'pistol_pack/pistol walk.fbx',
    pistol_run: 'pistol_pack/pistol run.fbx',
    pistol_walk_backward: 'pistol_pack/pistol walk backward.fbx',
    pistol_run_backward: 'pistol_pack/pistol run backward.fbx',
    pistol_strafe_left: 'pistol_pack/pistol strafe.fbx',
    pistol_strafe_right: 'pistol_pack/pistol strafe (2).fbx',
    pistol_fire: 'Gunplay.fbx',
    pistol_reload: 'Reloading.fbx',
    hit_reaction: 'Hit Reaction.fbx',
  },
};

const wanted = process.argv.slice(2);
for (const [pack, clips] of Object.entries(PACKS)) {
  if (wanted.length && !wanted.includes(pack)) continue;
  const stage = mkdtempSync(join(tmpdir(), `${pack}-`));
  try {
    for (const [name, file] of Object.entries(clips)) {
      const src = join(raw, file);
      if (!existsSync(src))
        throw new Error(`${pack}: missing ${src} (unzip the Mixamo packs first)`);
      symlinkSync(src, join(stage, `${name}.fbx`));
    }
    mkdirSync(out, { recursive: true });
    const target = join(out, `${pack}.glb`);
    const run = spawnSync(
      blender,
      [
        '-b',
        '--factory-startup',
        '--python',
        join(root, 'scripts/blender/convert_animations.py'),
        '--',
        stage,
        target,
      ],
      { encoding: 'utf8' },
    );
    const lines = `${run.stdout}${run.stderr}`
      .split('\n')
      .filter((l) => /^(CLIP|SKIP|BUILT)|Error/.test(l));
    console.log(lines.join('\n'));
    if (run.status !== 0 || !existsSync(target)) throw new Error(`${pack}: Blender failed`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
