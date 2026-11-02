import { carriageHalfWidth, generateCity } from '@fr33world/city';
import { MODE } from '@fr33world/protocol';
import { SPEED } from '@fr33world/shared';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Character } from './character/character.ts';
import { SLAB_Y } from './city/city.ts';
import type { Input } from './input.ts';
import { Physics } from './physics.ts';
import { LocalPlayer } from './player.ts';

const city = generateCity();
let physics: Physics;

beforeAll(async () => {
  physics = await Physics.create(city);
  // Building the whole city's physics: seconds, more with every test file running at once.
}, 60_000);

function stick(x: number, y: number, walk = false): Input {
  return { move: { x, y }, walk } as Input;
}

/** Runs `seconds` of fixed steps facing +z (camera yaw 0). */
function run(player: LocalPlayer, input: Input, seconds: number, jumpAt = -1) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i += 1) {
    // As the game does: only the city around the player is in the physics world.
    physics.focus(player.position.x, player.position.z);
    player.step(input, 0, i === jumpAt);
    physics.step();
    player.sync(1 / 60);
  }
}

describe('local player movement', () => {
  it('stands the character up on its yaw alone after a seat turned it past 90°', () => {
    const p = city.plaza;
    const player = new LocalPlayer(physics, {
      x: (p.x0 + p.x1) / 2 + 30,
      y: SLAB_Y,
      z: p.z0 + 5,
      yaw: 0,
    });
    const root = new THREE.Object3D();
    player.character = { root, update: () => {} } as unknown as Character;
    // What seatCharacter leaves behind: a car facing back down the road (x and z at ±π).
    root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.6);
    run(player, stick(0, 1), 0.5);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
    expect(facing.z).toBeGreaterThan(0.99);
    player.character = null;
  });

  it('stands on the plaza and runs forward at about run speed', () => {
    const p = city.plaza;
    const player = new LocalPlayer(physics, {
      x: (p.x0 + p.x1) / 2 - 20,
      y: SLAB_Y,
      z: p.z0 + 5,
      yaw: 0,
    });
    run(player, stick(0, 0), 0.5);
    expect(player.position.y).toBeCloseTo(SLAB_Y + 0.004, 1);
    expect(player.grounded).toBe(true);
    const z0 = player.position.z;
    run(player, stick(0, 1), 2);
    const travelled = player.position.z - z0;
    expect(travelled).toBeGreaterThan(SPEED.RUN * 0.75 * 2 * 0.85);
    // Never faster than the server accepts.
    expect(travelled).toBeLessThan(SPEED.RUN * 2);
    expect(player.mode).toBe(MODE.RUN);
  });

  it('draws between physics steps at any frame rate (smooth, no jumps)', () => {
    const p = city.plaza;
    const player = new LocalPlayer(physics, {
      x: (p.x0 + p.x1) / 2 - 30,
      y: SLAB_Y,
      z: p.z0 + 5,
      yaw: 0,
    });
    run(player, stick(0, 1), 1);
    // One more step; then draw the frame at different fractions of the way through it.
    player.step(stick(0, 1), 0, false);
    physics.step();
    player.sync(1 / 60, 0);
    const before = player.position.z;
    player.sync(1 / 60, 1);
    const after = player.position.z;
    expect(after - before).toBeGreaterThan(0.05);
    player.sync(1 / 60, 0.5);
    expect(player.position.z).toBeCloseTo((before + after) / 2, 4);
  });

  it('keeps its stride across open paving: no step stalls and flicks the legs to idle', () => {
    const p = city.plaza;
    for (const walk of [false, true]) {
      const player = new LocalPlayer(physics, {
        x: p.x0 + 3,
        y: SLAB_Y,
        z: (p.z0 + p.z1) / 2 + 20,
        yaw: Math.PI / 2,
      });
      const input = stick(0, 1, walk);
      for (let i = 0; i < 300; i += 1) {
        physics.focus(player.position.x, player.position.z);
        player.step(input, Math.PI / 2, false);
        physics.step();
        player.sync(1 / 60);
        if (i > 30) expect(player.mode).toBe(walk ? MODE.WALK : MODE.RUN);
      }
    }
  });

  it('walks slower when asked to', () => {
    const p = city.plaza;
    const player = new LocalPlayer(physics, {
      x: (p.x0 + p.x1) / 2 + 20,
      y: SLAB_Y,
      z: p.z0 + 5,
      yaw: 0,
    });
    run(player, stick(0, 0), 0.3);
    const z0 = player.position.z;
    run(player, stick(0, 1, true), 2);
    expect(player.position.z - z0).toBeLessThan(4);
    expect(player.mode).toBe(MODE.WALK);
  });

  it('is stopped by a building wall', () => {
    const b = city.buildings.find((x) => x.style !== 'warehouse' && x.z > -100 && x.z < 100);
    if (!b) throw new Error('no building');
    // Start on the sidewalk just north of the building and run south into it.
    const startZ = b.z - b.d / 2 - 3;
    const player = new LocalPlayer(physics, { x: b.x, y: SLAB_Y, z: startZ, yaw: 0 });
    run(player, stick(0, 1), 3);
    expect(player.position.z).toBeLessThan(b.z - b.d / 2);
  });

  it('jumps and lands again', () => {
    const p = city.plaza;
    const player = new LocalPlayer(physics, { x: p.x0 + 3, y: SLAB_Y, z: p.z1 - 3, yaw: 0 });
    run(player, stick(0, 0), 0.3);
    let peak = 0;
    for (let i = 0; i < 90; i += 1) {
      physics.focus(player.position.x, player.position.z);
      player.step(stick(0, 0), 0, i === 0);
      physics.step();
      player.sync(1 / 60);
      peak = Math.max(peak, player.position.y);
    }
    expect(peak - SLAB_Y).toBeGreaterThan(0.6);
    expect(player.grounded).toBe(true);
    expect(player.position.y).toBeLessThan(SLAB_Y + 0.1);
  });

  it('steps up a curb from the road onto the sidewalk', () => {
    const grand = city.roads.find((r) => r.name === 'Grand Avenue');
    if (!grand) throw new Error('no Grand Avenue');
    // In the carriageway just south of the plaza block, running north onto its sidewalk.
    const x = (city.plaza.x0 + city.plaza.x1) / 2;
    const z = grand.center - carriageHalfWidth(grand) + 2;
    const player = new LocalPlayer(physics, { x, y: 0, z, yaw: Math.PI });
    run(player, stick(0, 0), 0.3);
    expect(player.position.y).toBeLessThan(0.05);
    run(player, stick(0, -1), 1.5);
    expect(player.position.y).toBeGreaterThan(SLAB_Y - 0.02);
  });

  it('keeps running over kerbs and across a street without a single falling step', () => {
    // From the plaza south over its edge, the sidewalk's kerb, Grand Avenue and back up.
    const p = city.plaza;
    const player = new LocalPlayer(physics, {
      x: (p.x0 + p.x1) / 2 - 20,
      y: SLAB_Y,
      z: p.z1 - 6,
      yaw: 0,
    });
    run(player, stick(0, 0), 0.3);
    const modes: number[] = [];
    for (let i = 0; i < 4 * 60; i += 1) {
      physics.focus(player.position.x, player.position.z);
      player.step(stick(0, 1), 0, false);
      physics.step();
      player.sync(1 / 60);
      modes.push(player.mode);
    }
    expect(player.position.z).toBeGreaterThan(p.z1 + 12);
    expect(modes.filter((m) => m === MODE.FALL || m === MODE.JUMP)).toEqual([]);
  });
});
