/**
 * Ramps (Phase 2, owner 2026-10-29: "a flyover with connected routes in the middle of the
 * city"): the interchange where the Sol Freeway (deck 10 m) crosses under the Valley Freeway
 * (deck 18 m), with a curved connector in each quadrant between the two decks; and at each end
 * of each deck, its descent to a junction at street level, where it carries on as a parkway
 * (owner: a flyover slopes down and merges with the road, it doesn't run to the city's end).
 *
 * A ramp is a centreline with heights; its surface is `width` wide. A connector meets a deck
 * running along the deck's edge at the deck's height (half over the deck), and the barrier on
 * that edge has a gap (`barrierGaps`); a descent carries on from the deck's end at its full
 * width, lanes and centre barrier. Shared by the server (heights), physics and drawing.
 */
import type { Freeway, Pillar, Road } from './layout.ts';
import { SOL_ELEVATED, SOL_FREEWAY_Z, VALLEY_ELEVATED, VALLEY_FREEWAY_X } from './plan.ts';

export interface RampPoint {
  x: number;
  y: number;
  z: number;
}

export interface Ramp {
  name: string;
  /** A connector between the decks, or a deck's descent to the street. */
  kind: 'connector' | 'descent';
  width: number;
  /** The slab's thickness under its surface (m). */
  depth: number;
  /** The centreline, from one end to the other. */
  points: RampPoint[];
  /** Columns under it (each up to the ramp's underside at that point). */
  pillars: (Pillar & { top: number })[];
}

export const RAMP_WIDTH = 10;
/** The connectors' slab thickness, and the decks' (which the descents carry on). */
const RAMP_DEPTH = 1.2;
export const DECK_DEPTH = 1.4;
/** Height a connector must clear over a street before a column can stand (m). */
const PILLAR_FROM = 4.5;
/** Radius of the interchange's connectors (m) and their level runs at each end. */
const CONNECTOR_R = 90;
const LEVEL_RUN = 30;
/** Length over which a descent's grade builds up at the top and levels out at the foot (m). */
const EASE = 40;

/** Heights along a path: level for `flat0` m, a straight climb, level for the last `flat1` m. */
function withHeights(
  xz: [number, number][],
  y0: number,
  y1: number,
  flat0: number,
  flat1: number,
): RampPoint[] {
  const along = [0];
  for (let i = 1; i < xz.length; i += 1) {
    const [ax, az] = xz[i - 1] as [number, number];
    const [bx, bz] = xz[i] as [number, number];
    along.push((along[i - 1] as number) + Math.hypot(bx - ax, bz - az));
  }
  const total = along[along.length - 1] as number;
  return xz.map(([x, z], i) => {
    const s = along[i] as number;
    const t = Math.min(1, Math.max(0, (s - flat0) / (total - flat0 - flat1)));
    return { x, y: y0 + (y1 - y0) * t, z };
  });
}

/**
 * A connector: from the Sol deck's edge (heading along it), a quarter circle round the
 * quadrant's corner, onto the Valley deck's edge. `sx`, `sz`: which quadrant (+1 east/south).
 */
function connector(sol: Freeway, valley: Freeway, sx: 1 | -1, sz: 1 | -1): Ramp {
  const solEdge = sol.center + sz * (sol.width / 2);
  const valleyEdge = valley.center + sx * (valley.width / 2);
  const cx = valleyEdge + sx * CONNECTOR_R;
  const cz = solEdge + sz * CONNECTOR_R;
  // From the Sol edge point (straight in z from the centre) to the Valley edge point.
  const a0 = Math.atan2(-sz, 0);
  const a1 = Math.atan2(0, -sx);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const xz: [number, number][] = [[cx + sx * 15, solEdge]];
  const STEPS = 24;
  for (let i = 0; i <= STEPS; i += 1) {
    const a = a0 + (sweep * i) / STEPS;
    xz.push([cx + Math.cos(a) * CONNECTOR_R, cz + Math.sin(a) * CONNECTOR_R]);
  }
  xz.push([valleyEdge, cz + sz * 15]);
  const name = `${sz < 0 ? 'North' : 'South'}-${sx > 0 ? 'east' : 'west'} connector`;
  return {
    name,
    kind: 'connector',
    width: RAMP_WIDTH,
    depth: RAMP_DEPTH,
    points: withHeights(xz, sol.deckY, valley.deckY, 15 + LEVEL_RUN, 15 + LEVEL_RUN),
    pillars: [],
  };
}

/** How far the deck's road has dropped `s` m down a descent of length `len` (eased ends). */
function drop(s: number, len: number, rise: number): number {
  const grade = rise / (len - EASE);
  if (s < EASE) return (grade * s * s) / (2 * EASE);
  if (s > len - EASE) return rise - (grade * (len - s) ** 2) / (2 * EASE);
  return grade * (s - EASE / 2);
}

/**
 * A deck's descent from its end (`end` +1: its `to` end) down to `foot`, the near edge of the
 * junction it lands in, on columns in pairs like the deck's.
 */
function descent(fw: Freeway, end: 1 | -1, foot: number, roads: Road[]): Ramp {
  const top = end > 0 ? fw.to : fw.from;
  const len = Math.abs(foot - top);
  const at = (a: number, c: number): [number, number] => (fw.axis === 'ew' ? [a, c] : [c, a]);
  const steps = Math.ceil(len / 8);
  const points: RampPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const s = (len * i) / steps;
    const [x, z] = at(top + end * s, fw.center);
    points.push({ x, y: fw.deckY - drop(s, len, fw.deckY), z });
  }
  const pillars: Ramp['pillars'] = [];
  for (let s = 16; s < len; s += 32) {
    const y = fw.deckY - drop(s, len, fw.deckY) - DECK_DEPTH;
    if (y < 3) break;
    for (const off of [-9, 9]) {
      const [x, z] = at(top + end * s, fw.center + off);
      if (onCarriageway(roads, x, z, 3)) continue;
      pillars.push({ x, z, w: 2.2, d: 2.2, top: y });
    }
  }
  const way = fw.axis === 'ew' ? (end > 0 ? 'east' : 'west') : end > 0 ? 'south' : 'north';
  return {
    name: `${fw.name} ${way} descent`,
    kind: 'descent',
    width: fw.width,
    depth: DECK_DEPTH,
    points,
    pillars,
  };
}

/** Is (x, z) on a road's carriageway (with a margin)? */
function onCarriageway(roads: Road[], x: number, z: number, margin: number): boolean {
  return roads.some((r) => {
    const half = r.lanesPerDir * r.laneWidth + r.median / 2 + margin;
    const [along, across] = r.axis === 'ns' ? [z, x] : [x, z];
    return (
      along >= r.from - margin && along <= r.to + margin && Math.abs(across - r.center) <= half
    );
  });
}

export function makeRamps(roads: Road[], freeways: Freeway[]): Ramp[] {
  const sol = freeways.find((f) => f.axis === 'ew' && f.center === SOL_FREEWAY_Z);
  const valley = freeways.find((f) => f.axis === 'ns' && f.center === VALLEY_FREEWAY_X);
  if (!sol || !valley) return [];
  const ramps: Ramp[] = [];
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) ramps.push(connector(sol, valley, sx, sz));
  }
  // Each deck comes down at both ends to the junction with the street where its elevated
  // stretch begins, landing at the edge of that street's carriageway.
  for (const [fw, lo, hi] of [
    [sol, SOL_ELEVATED.x0, SOL_ELEVATED.x1],
    [valley, VALLEY_ELEVATED.z0, VALLEY_ELEVATED.z1],
  ] as const) {
    const cross = (line: number) =>
      roads.find(
        (r) => r.axis !== fw.axis && r.center === line && fw.center >= r.from && fw.center <= r.to,
      );
    const [first, last] = [cross(lo), cross(hi)];
    if (!first || !last) throw new Error(`${fw.name} has no street to come down to`);
    ramps.push(
      descent(fw, -1, lo + first.lanesPerDir * first.laneWidth + first.median / 2, roads),
      descent(fw, 1, hi - (last.lanesPerDir * last.laneWidth + last.median / 2), roads),
    );
  }

  // Columns every 16 m along each connector wherever it's high enough, clear of the streets
  // under it and of the decks.
  for (const ramp of ramps) {
    if (ramp.kind !== 'connector') continue;
    const pts = ramp.points;
    let next = 8;
    let walked = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] as RampPoint;
      const b = pts[i] as RampPoint;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (; next <= walked + len; next += 16) {
        const t = (next - walked) / len;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = a.y + (b.y - a.y) * t;
        if (y < PILLAR_FROM) continue;
        if (onCarriageway(roads, x, z, 1.5)) continue;
        if (freeways.some((f) => onDeck(f, x, z, 2))) continue;
        ramp.pillars.push({ x, z, w: 1.6, d: 1.6, top: y - ramp.depth });
      }
      walked += len;
    }
  }
  return ramps;
}

/** Is (x, z) over a freeway's deck (with a margin)? */
export function onDeck(fw: Freeway, x: number, z: number, margin = 0): boolean {
  const [along, across] = fw.axis === 'ew' ? [x, z] : [z, x];
  return (
    along >= fw.from - margin &&
    along <= fw.to + margin &&
    Math.abs(across - fw.center) <= fw.width / 2 + margin
  );
}

/** The ramp's surface height at (x, z) (on its nearest segment), or null when off it. */
export function rampHeightAt(ramp: Ramp, x: number, z: number, margin = 0): number | null {
  let best: number | null = null;
  let nearest = Infinity;
  const reach = ramp.width / 2 + margin;
  for (let i = 1; i < ramp.points.length; i += 1) {
    const a = ramp.points[i - 1] as RampPoint;
    const b = ramp.points[i] as RampPoint;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) continue;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d > reach || d > nearest + 1e-6) continue;
    const y = a.y + (b.y - a.y) * t;
    // At a joint both segments are as near: they meet at the same height.
    best = d < nearest - 1e-6 || best === null ? y : Math.max(best, y);
    nearest = Math.min(nearest, d);
  }
  return best;
}

/**
 * Stretches of a deck's edge barriers left open where a ramp joins it: [side, from, to] in
 * the freeway's own along-axis (side -1 is the low-coordinate edge).
 */
export function barrierGaps(fw: Freeway, ramps: Ramp[]): [-1 | 1, number, number][] {
  const gaps: [-1 | 1, number, number][] = [];
  for (const side of [-1, 1] as const) {
    const edge = fw.center + side * (fw.width / 2);
    const hits: number[] = [];
    for (const ramp of ramps) {
      // Descents carry on from the deck's end, not alongside it.
      if (ramp.kind !== 'connector') continue;
      for (let i = 1; i < ramp.points.length; i += 1) {
        const a = ramp.points[i - 1] as RampPoint;
        const b = ramp.points[i] as RampPoint;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let s = 0; s <= len; s += 1) {
          const t = len === 0 ? 0 : s / len;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const y = a.y + (b.y - a.y) * t;
          if (Math.abs(y - fw.deckY) > 0.3) continue;
          const [along, across] = fw.axis === 'ew' ? [x, z] : [z, x];
          if (along < fw.from || along > fw.to) continue;
          if (Math.abs(across - edge) <= ramp.width / 2 + 0.5) hits.push(along);
        }
      }
    }
    hits.sort((p, q) => p - q);
    let open: [number, number] | null = null;
    for (const h of hits) {
      if (open && h - open[1] <= 3) open[1] = h;
      else {
        if (open) gaps.push([side, open[0] - 2, open[1] + 2]);
        open = [h, h];
      }
    }
    if (open) gaps.push([side, open[0] - 2, open[1] + 2]);
  }
  return gaps;
}
