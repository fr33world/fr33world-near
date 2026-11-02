import { describe, expect, it } from 'vitest';
import { type Interaction, Interactions, type Reach } from './interactions.ts';

const here: Reach = { x: 0, y: 0, z: 0, yaw: 0, driving: false };
function offer(key: string, x: number, z: number, extra: Partial<Interaction> = {}) {
  const done: string[] = [];
  const o: Interaction = {
    key,
    label: key,
    icon: 'info',
    at: { x, y: 1, z },
    distance: Math.hypot(x, z),
    run: () => done.push(key),
    ...extra,
  };
  return { o, done };
}

describe('interaction prompts', () => {
  it('picks the nearest, favouring what the player faces', () => {
    const ix = new Interactions();
    const ahead = offer('ahead', 0, 2); // yaw 0 faces +z
    const behind = offer('behind', 0, -1.8);
    ix.add(() => [ahead.o, behind.o]);
    expect(ix.pick(here)?.key).toBe('ahead');
    expect(ix.pick({ ...here, yaw: Math.PI })?.key).toBe('behind');
  });

  it('does a press once, on the frame it is pressed', () => {
    const ix = new Interactions();
    const k = offer('kiosk', 0, 1);
    ix.add(() => k.o);
    expect(ix.update(here, false, false, 0)).toBeNull();
    expect(ix.update(here, true, true, 16)?.key).toBe('kiosk');
    expect(ix.update(here, false, true, 32)).toBeNull();
    expect(k.done).toEqual(['kiosk']);
  });

  it('fills a hold, does it once, and starts over on letting go or a new target', () => {
    const ix = new Interactions();
    const ore = offer('ore', 0, 1, { holdMs: 1000 });
    let near = true;
    ix.add(() => (near ? ore.o : null));
    ix.update(here, true, true, 0);
    ix.update(here, false, true, 500);
    expect(ix.progress).toBeCloseTo(0.5);
    ix.update(here, false, false, 600);
    expect(ix.progress).toBe(0);
    ix.update(here, true, true, 1000);
    ix.update(here, false, true, 2000);
    expect(ore.done).toEqual(['ore']);
    // Still held: not again until let go.
    ix.update(here, false, true, 3500);
    expect(ore.done).toHaveLength(1);
    near = false;
    ix.update(here, false, true, 3600);
    expect(ix.current).toBeNull();
  });

  it('removes a source', () => {
    const ix = new Interactions();
    const remove = ix.add(() => offer('x', 0, 1).o);
    remove();
    expect(ix.pick(here)).toBeNull();
  });
});
