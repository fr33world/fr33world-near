import { generateCity } from '@fr33world/city';
import { SPEED } from '@fr33world/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { Physics } from '../physics.ts';
import { CARS, type CarSpec } from './car-model.ts';
import { type DriveInput, DrivenCar } from './driving.ts';

const city = generateCity();
let physics: Physics;
// The physics world for the whole city takes a while to build when the suite runs in parallel.
beforeAll(async () => {
  physics = await Physics.create(city);
}, 30_000);

const idle: DriveInput = { throttle: 0, steer: 0, brake: false, handbrake: false };

function drive(car: DrivenCar, input: DriveInput, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    physics.focus(car.position.x, car.position.z);
    car.step(input);
    physics.step();
    car.sync();
  }
}

/** A car on Hope St facing +z (south), well clear of junction traffic. */
function hopeStreetCar(spec: CarSpec, offsetZ = 0) {
  const hope = city.roads.find((r) => r.name === 'Hope St');
  if (!hope) throw new Error('no Hope St');
  return new DrivenCar(physics, spec, hope.center + 3.5 + offsetZ * 0, 0, -200 + offsetZ, 0);
}

describe('driving', () => {
  it('settles on its wheels and accelerates forward', () => {
    const car = hopeStreetCar(CARS[0] as CarSpec);
    drive(car, idle, 1);
    expect(car.position.y).toBeGreaterThan(-0.2);
    expect(car.position.y).toBeLessThan(0.3);
    const z0 = car.position.z;
    drive(car, { ...idle, throttle: 1 }, 3);
    expect(car.position.z - z0).toBeGreaterThan(10);
    expect(car.speed).toBeGreaterThan(5);
    expect(Math.abs(car.yaw)).toBeLessThan(0.1);
    // Still riding on its suspension, not sagging into the road.
    drive(car, idle, 2);
    expect(car.position.y).toBeGreaterThan(-0.04);
    expect(car.position.y).toBeLessThan(0.08);
  });

  it('is drawn between physics steps, so a fast car moves smoothly', () => {
    const car = hopeStreetCar(CARS[2] as CarSpec, 120);
    drive(car, idle, 0.5);
    drive(car, { ...idle, throttle: 1 }, 3);
    car.step({ ...idle, throttle: 1 });
    physics.step();
    car.sync(0);
    const before = car.position.z;
    car.sync(1);
    const after = car.position.z;
    // At speed, one step moves the car visibly; half a frame later it's drawn half-way.
    expect(after - before).toBeGreaterThan(0.1);
    car.sync(0.5);
    expect(car.position.z).toBeCloseTo((before + after) / 2, 4);
  });

  it('turns right when steering right', () => {
    const car = hopeStreetCar(CARS[1] as CarSpec, 60);
    drive(car, idle, 0.5);
    drive(car, { ...idle, throttle: 0.6 }, 1.5);
    drive(car, { ...idle, throttle: 0.4, steer: 1 }, 1);
    // Facing +z, turning right swings the nose towards -x: yaw goes negative.
    expect(car.yaw).toBeLessThan(-0.2);
  });

  it('brakes to a stop and never exceeds what the server accepts', () => {
    const car = hopeStreetCar(CARS[1] as CarSpec, 120);
    drive(car, idle, 0.5);
    let top = 0;
    for (let i = 0; i < 6 * 60; i += 1) {
      car.step({ ...idle, throttle: 1 });
      physics.step();
      car.sync();
      top = Math.max(top, Math.hypot(car.velocity.x, car.velocity.z));
    }
    expect(top).toBeLessThan(SPEED.VEHICLE_MAX);
    drive(car, { ...idle, brake: true }, 4);
    expect(Math.abs(car.speed)).toBeLessThan(1);
  });
});

describe('freeway ramps', () => {
  it('drives off Sol Parkway up the descent onto the freeway deck', () => {
    const sol = city.freeways.find((f) => f.name === 'Sol Freeway');
    const ramp = city.ramps.find((r) => r.name === 'Sol Freeway west descent');
    if (!sol || !ramp) throw new Error('no Sol Freeway descent');
    // Up the ramp from its foot, in the eastbound lanes (right-hand traffic: south of centre).
    const lane = sol.center + 6;
    const foot = ramp.points[ramp.points.length - 1] as (typeof ramp.points)[number];
    const car = new DrivenCar(physics, CARS[0] as CarSpec, foot.x - 30, 0, lane, Math.PI / 2);
    drive(car, idle, 0.5);
    for (let i = 0; i < 25 * 60; i += 1) {
      // Hold the lane: aim 15 m ahead on it.
      let turn = Math.atan2(15, lane - car.position.z) - car.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      physics.focus(car.position.x, car.position.z);
      // Steering right (positive) turns the nose towards smaller yaw.
      car.step({ ...idle, throttle: 1, steer: Math.max(-1, Math.min(1, -turn * 2)) });
      physics.step();
      car.sync();
      if (car.position.x > sol.from + 20) break;
    }
    expect(car.position.x).toBeGreaterThan(sol.from);
    expect(car.position.y).toBeGreaterThan(sol.deckY - 0.5);
    expect(car.position.y).toBeLessThan(sol.deckY + 0.6);
    expect(Math.abs(car.position.z - sol.center)).toBeLessThan(sol.width / 2);
  });
});

describe('hill roads', () => {
  it('drives up Observatory Road from Sol Boulevard, round its hairpins, to the observatory', () => {
    const road = city.hillRoads.find((r) => r.name === 'Observatory Road');
    if (!road) throw new Error('no Observatory Road');
    const pts = road.points;
    // The right-hand lane's line: 1.75 m right of the centreline.
    const lane = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)] as (typeof pts)[number];
      const b = pts[Math.min(pts.length - 1, i + 1)] as (typeof pts)[number];
      const n = Math.hypot(b.x - a.x, b.z - a.z);
      return { x: p.x - ((b.z - a.z) / n) * 1.75, y: p.y, z: p.z + ((b.x - a.x) / n) * 1.75 };
    });
    const start = pts[0] as (typeof pts)[number];
    // On Sol Boulevard's northbound side, 20 m short of where the hill road starts.
    const car = new DrivenCar(
      physics,
      CARS[0] as CarSpec,
      start.x + 1.75,
      0,
      start.z + 20,
      Math.PI,
    );
    drive(car, idle, 0.5);
    let at = 0;
    let worst = 0;
    for (let i = 0; i < 240 * 60 && at < lane.length - 4; i += 1) {
      // The nearest lane point ahead, then aim 10 m beyond it.
      const { x, z } = car.position;
      for (let k = at; k < Math.min(lane.length, at + 12); k += 1) {
        const p = lane[k] as (typeof lane)[number];
        const q = lane[at] as (typeof lane)[number];
        if (Math.hypot(p.x - x, p.z - z) < Math.hypot(q.x - x, q.z - z)) at = k;
      }
      const near = lane[at] as (typeof lane)[number];
      // Once on the hill road (it starts 20 m ahead).
      if (at > 2) worst = Math.max(worst, Math.hypot(near.x - x, near.z - z));
      const aim = lane[Math.min(lane.length - 1, at + 3)] as (typeof lane)[number];
      let turn = Math.atan2(aim.x - x, aim.z - z) - car.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      physics.focus(x, z);
      // Hairpin speed: about 30 km/h.
      const fast = Math.abs(car.speed) > 8.5;
      car.step({
        ...idle,
        throttle: fast ? 0 : 0.8,
        brake: Math.abs(car.speed) > 11,
        steer: Math.max(-1, Math.min(1, -turn * 2)),
      });
      physics.step();
      car.sync();
    }
    const end = lane[lane.length - 1] as (typeof lane)[number];
    expect(Math.hypot(car.position.x - end.x, car.position.z - end.z)).toBeLessThan(20);
    expect(car.position.y).toBeGreaterThan(end.y - 1.5);
    // On the carriageway all the way (a hairpin's apex cut a little).
    expect(worst).toBeLessThan(4);
    // Two minutes of driving simulated: slower than the default limit when the suite runs.
  }, 30_000);
});

describe('car models', () => {
  it('parks every everyday model, and only those', async () => {
    const { PARKED_CAR_MODELS } = await import('@fr33world/city');
    const { CIVILIAN_CARS, CAR_MODELS } = await import('@fr33world/shared');
    expect(PARKED_CAR_MODELS).toBe(CIVILIAN_CARS);
    // Measured from the models: real car sizes, wheels at the corners.
    for (const m of CAR_MODELS) {
      expect(m.length).toBeGreaterThan(3);
      expect(m.length).toBeLessThan(6);
      expect(m.wheelRadius).toBeGreaterThan(0.2);
      const [fl, fr, rl, rr] = m.wheels;
      expect(fl?.[0]).toBeGreaterThan(0);
      expect(fr?.[0]).toBeLessThan(0);
      expect(fl?.[2]).toBeGreaterThan(0);
      expect(rl?.[2] ?? 0).toBeLessThan(0);
      expect(rr?.[2] ?? 0).toBeLessThan(0);
    }
  });
});

describe('handling per model', () => {
  it('every model rides at its height, pulls away, brakes, and keeps its own character', () => {
    const results = CARS.map((spec, k) => {
      // Each on its own stretch of Hope St, well apart.
      const car = hopeStreetCar(spec, 200 + k * 60);
      drive(car, idle, 1);
      const height = car.position.y;
      drive(car, { ...idle, throttle: 1 }, 3);
      const pulled = car.speed;
      drive(car, { ...idle, brake: true }, 3);
      const stopped = Math.abs(car.speed);
      car.dispose();
      return { id: spec.id, height, pulled, stopped };
    });
    for (const r of results) {
      expect(r.height, r.id).toBeGreaterThan(-0.06);
      expect(r.height, r.id).toBeLessThan(0.1);
      expect(r.pulled, r.id).toBeGreaterThan(6);
      expect(r.stopped, r.id).toBeLessThan(0.5);
    }
    // The Sport leaves the Ambulance behind.
    const of = (id: string) => results.find((r) => r.id === id)?.pulled ?? 0;
    expect(of('sport')).toBeGreaterThan(of('ambulance') * 1.3);
    // Thirteen cars driven for seven seconds each: longer than a unit test's usual limit.
  }, 30_000);
});
