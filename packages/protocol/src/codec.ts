/**
 * World protocol v1: hand-written binary messages over WebSocket, [u8 type][payload],
 * little-endian. Positions are 24-bit at 1/64 m (±131 km, 1.6 cm steps), heights 16-bit at
 * 1/64 m (±512 m), velocities 16-bit at 1 cm/s (±327 m/s), yaw u16 over a full turn.
 *
 * Movement is owner-simulated and server-validated (decision D-05): the client reports the
 * pose of whatever it controls (its character, or the car it drives) and the server accepts,
 * corrects or rejects it.
 */
import { DecodeError, Reader, Writer } from './buffer.ts';

/** v2: `hello` carries the player's access token (empty when playing unauthenticated in dev). */
export const PROTOCOL_VERSION = 18;

/** What a player does with `act`. */
export const ACT = {
  /** Through the entrance or exit `arg` (a city point). */
  DOOR: 1,
  /** Down: give up waiting and wake in a hospital bed. */
  FAINT: 2,
  /** Down: call EMS, and wait for them. */
  CALL_EMS: 3,
  /** In a hospital bed: get up now, with the health you have. */
  GET_UP: 4,
  /** At the lockers: on or off duty. */
  LOCKER: 5,
  /** At the Hospital's counter: buy CARE item `arg`. */
  BUY_CARE: 6,
  /** Use CARE item `arg`. */
  USE_CARE: 7,
  /** Sit on seat `arg` of the room you're in. */
  SIT: 8,
  /** Up from a seat. */
  STAND: 9,
  /** At Sunny's till: buy GOODS item `arg` for `$`. */
  BUY_GOOD: 10,
} as const;

export const POS_SCALE = 64;
export const VEL_SCALE = 100;
const PITCH_SCALE = 10_000;
const TAU = Math.PI * 2;

export const C2S = {
  HELLO: 1,
  STATE: 2,
  PING: 3,
  ENTER_VEHICLE: 4,
  EXIT_VEHICLE: 5,
  SHOT: 6,
  CHAT: 7,
  EMOTE: 8,
  JOB: 9,
  CALL_CAR: 10,
  TAXI: 11,
  SERVICE: 12,
  EQUIP: 13,
  RELOAD: 14,
  BUY: 15,
  REVIVE: 16,
  ACT: 17,
} as const;

/** What a `service` message asks for at a car park: fuel or a repair for the player's car. */
export const SERVICE = { FUEL: 1, REPAIR: 2 } as const;

/** What a `job` message asks (Phase 6 jobs): take a job at a point, use a point, or quit. */
export const JOB_OP = { START: 1, USE: 2, QUIT: 3 } as const;

/**
 * Emotes, by number on the wire: the clip each plays (animation packs), whether it loops
 * until the player moves, and its name on screen.
 */
export const EMOTES = [
  { clip: 'waving', loop: false, name: 'Wave' },
  { clip: 'clapping', loop: true, name: 'Clap' },
  { clip: 'laughing', loop: false, name: 'Laugh' },
  { clip: 'pointing', loop: false, name: 'Point' },
  { clip: 'standing_thumbs_up', loop: false, name: 'Thumbs up' },
  { clip: 'talking_1', loop: true, name: 'Chat' },
  { clip: 'dancing', loop: true, name: 'Dance' },
  { clip: 'hip_hop_dancing', loop: true, name: 'Hip hop' },
  { clip: 'dancing_twerk', loop: true, name: 'Twerk' },
  { clip: 'snake_hip_hop', loop: true, name: 'Snake' },
  { clip: 'step_hip_hop', loop: true, name: 'Step' },
  // Patching up, not picked from the menu: others see it when you use the item.
  { clip: 'bandaging', loop: false, name: 'Bandage', menu: false },
  { clip: 'medicine', loop: false, name: 'Medicine', menu: false },
] as const;

/** Proximity text chat: how far a message carries (m), and its longest (characters). */
export const CHAT = { RANGE: 30, MAX_CHARS: 140 } as const;

export const S2C = {
  WELCOME: 101,
  SNAPSHOT: 102,
  ENTER: 103,
  LEAVE: 104,
  PONG: 105,
  CLOCK: 106,
  SEAT: 107,
  CORRECTION: 108,
  SHOT_FX: 109,
  HIT: 110,
  HEALTH: 111,
  ERROR: 112,
  VOICE: 113,
  CHAT: 114,
  EMOTE: 115,
  JOB: 116,
  REWARD: 117,
  RIDE: 118,
  CAR: 119,
  ARMS: 120,
  DISPATCH: 121,
} as const;

/** Low nibble of `state`: what the body is doing. */
export const MODE = {
  IDLE: 0,
  WALK: 1,
  RUN: 2,
  JUMP: 3,
  FALL: 4,
  /** Seated in a vehicle; the player is drawn by the vehicle entity. */
  SEATED: 5,
  /** Downed at 0 HP, waiting for a medic or respawn. */
  DOWNED: 6,
  /** Sat on a chair in a room. */
  SITTING: 7,
} as const;
/** High-nibble flags of `state`. */
export const FLAG = {
  AIM: 0x10,
  /** Vehicle only: headlights on. */
  LIGHTS: 0x20,
  /** Player only: holding a weapon (others see the stance and the gun). */
  ARMED: 0x40,
  /** Player only: talking on the mic (others see the talking gestures). */
  TALKING: 0x80,
  /** Player only (the bit cars use for LIGHTS): the weapon in hand is the rifle. */
  RIFLE: 0x20,
  /** Vehicle only (from its driver, the bit players use for AIM): the horn is sounding. */
  HORN: 0x10,
  /** Vehicle only (set by the server): damaged, smoking. */
  DAMAGED: 0x40,
  /** Vehicle only (set by the server): wrecked, black smoke, won't go. */
  WRECKED: 0x80,
} as const;
export const modeOf = (state: number) => state & 0x0f;

export const ENTITY_KIND = { PLAYER: 0, VEHICLE: 1 } as const;

/** In-game weapon names avoid trademarks (technical-plan §9). */
export const WEAPON = { NONE: 0, HEAVY_PISTOL: 1, ASSAULT_RIFLE: 2, FIST: 3 } as const;

export const HIT_ZONE = { BODY: 0, HEAD: 1, LIMB: 2 } as const;

export const NO_ENTITY = 0xffff;

export const ERROR_CODE = {
  BAD_VERSION: 1,
  SERVER_FULL: 2,
  BAD_MESSAGE: 3,
  KICKED: 4,
  SEAT_DENIED: 5,
  /** Missing or invalid login (world requires auth), or signed in elsewhere. */
  UNAUTHORIZED: 6,
} as const;

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Radians, 0 = facing +z, increasing counter-clockwise seen from above. */
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  /** MODE | FLAG bits. */
  state: number;
}

/** One entity in a snapshot. Vertical speed is left out; clients only need it for their own body. */
export interface EntityUpdate {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  state: number;
}

export interface ClockMsg {
  realMs: number;
  gameMinutes: number;
  rate: number;
}

export type ClientMessage =
  | { type: 'hello'; version: number; name: string; token: string }
  | ({ type: 'state'; seq: number } & Pose)
  | { type: 'ping'; clientTime: number }
  | { type: 'enter_vehicle'; vehicle: number }
  | { type: 'exit_vehicle' }
  | {
      type: 'shot';
      seq: number;
      weapon: number;
      /** Server time (ms) the shooter was looking at when firing: render time, not now. */
      viewTime: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
    }
  | { type: 'chat'; text: string }
  /** Starts an emote (index into EMOTES); it stops when the player moves. */
  | { type: 'emote'; emote: number }
  /** A job action (JOB_OP) at a city point (index into the layout's `points`). */
  | { type: 'job'; op: number; point: number }
  /** v8: brings one of the player's own cars (the API garage's id) to the car park at `point`. */
  | { type: 'call_car'; point: number; car: number }
  /** v11: asks for a taxi to (x, z) (the phone's Taxi app). */
  | { type: 'taxi'; x: number; z: number }
  /** v11: fuel or a repair (SERVICE) for the player's own car, at the car park at `point`. */
  | { type: 'service'; point: number; what: number }
  /** v12: takes a weapon in hand (WEAPON; NONE puts it away), reloads it, buys at `point`. */
  | { type: 'equip'; weapon: number }
  | { type: 'reload' }
  | { type: 'buy'; point: number; item: number }
  /** v13: an on-duty medic revives a downed player (entity id) beside them. */
  | { type: 'revive'; target: number }
  /** v15: something done at a place or to oneself (`what`: ACT; `arg` depends on it). */
  | { type: 'act'; what: number; arg: number };

export type ServerMessage =
  | {
      type: 'welcome';
      version: number;
      you: number;
      serverTime: number;
      clock: ClockMsg;
      spawn: Pose;
    }
  | { type: 'snapshot'; serverTime: number; entities: EntityUpdate[] }
  | {
      type: 'enter';
      id: number;
      kind: number;
      model: number;
      variant: number;
      name: string;
      /** A player's appearance (shared `encodeAppearance`); 0 for vehicles. */
      look: number;
      /** What they wear besides the outfit (shared `encodeGear`; 0 for vehicles). */
      gear: number;
      /** v13: their faction (shared factionCode; 0 none), for the name tag's colour. */
      faction?: number;
      /** v17: a player's level, shown beside their name (0 for vehicles). */
      level?: number;
    }
  | { type: 'leave'; id: number }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | ({ type: 'clock' } & ClockMsg)
  | { type: 'seat'; vehicle: number; driver: number }
  | ({ type: 'correction'; seq: number } & Pose)
  | {
      type: 'shot_fx';
      shooter: number;
      weapon: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
      /** Tracer length in metres, or -1 when the shot hit nothing within range. */
      distance: number;
    }
  | { type: 'hit'; target: number; shooter: number; zone: number; damage: number; hp: number }
  | { type: 'health'; hp: number; downed: boolean }
  | { type: 'error'; code: number; message: string }
  /** Proximity voice: the LiveKit server and this player's pass to it (sent after welcome). */
  | { type: 'voice'; url: string; token: string }
  /** A line of text said near you (`from`: the speaker's entity; also your own, echoed). */
  | { type: 'chat'; from: number; text: string }
  /** Someone in view started an emote. */
  | { type: 'emote'; from: number; emote: number }
  /** The player's job as the HUD shows it (JSON, the world's JobView), or '' for none. */
  | { type: 'job'; state: string }
  /** A reward was given: money and XP, the new XP total, and what for. */
  | { type: 'reward'; cents: number; xp: number; totalXp: number; reason: string }
  /**
   * v11: a taxi ride: under way (`seconds` on screen, the fare paid, where to; the player is
   * moved there at once), or turned down (`seconds` 0, `text` says why).
   */
  | { type: 'ride'; seconds: number; cents: number; text: string }
  /** v11: a car's fuel and condition (0–1), to its driver and to its owner. */
  | { type: 'car'; vehicle: number; fuel: number; health: number }
  /**
   * v12: what the player carries (JSON: shared Arms, the weapon in hand, its magazine, whether
   * reloading till when), after any change.
   */
  | { type: 'arms'; state: string }
  /** v13: the open incidents for an on-duty officer or medic (JSON list), after any change. */
  | { type: 'dispatch'; state: string };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** A 0–1 level in a byte (fuel, condition); a little left never reads as none. */
export const qUnit = (v: number) => (v <= 0 ? 0 : clamp(Math.ceil(v * 255), 1, 255));
export const qPos = (m: number) => clamp(Math.round(m * POS_SCALE), -0x7fffff, 0x7fffff);
export const qY = (m: number) => clamp(Math.round(m * POS_SCALE), -0x7fff, 0x7fff);
export const qVel = (ms: number) => clamp(Math.round(ms * VEL_SCALE), -0x7fff, 0x7fff);
export const qYaw = (rad: number) =>
  Math.round((((rad % TAU) + TAU) % TAU) * (65536 / TAU)) & 0xffff;
export const dqYaw = (q: number) => (q * TAU) / 65536;
const qPitch = (rad: number) => clamp(Math.round(rad * PITCH_SCALE), -0x7fff, 0x7fff);

function writePose(w: Writer, p: Pose) {
  w.i24(qPos(p.x)).i16(qY(p.y)).i24(qPos(p.z)).u16(qYaw(p.yaw));
  w.i16(qVel(p.vx)).i16(qVel(p.vy)).i16(qVel(p.vz)).u8(p.state);
}

function readPose(r: Reader): Pose {
  return {
    x: r.i24() / POS_SCALE,
    y: r.i16() / POS_SCALE,
    z: r.i24() / POS_SCALE,
    yaw: dqYaw(r.u16()),
    vx: r.i16() / VEL_SCALE,
    vy: r.i16() / VEL_SCALE,
    vz: r.i16() / VEL_SCALE,
    state: r.u8(),
  };
}

export function encodeClient(m: ClientMessage, w = new Writer(64)): Uint8Array<ArrayBuffer> {
  w.reset();
  switch (m.type) {
    case 'hello':
      w.u8(C2S.HELLO).u16(m.version).str(m.name).str(m.token);
      break;
    case 'state':
      w.u8(C2S.STATE).u16(m.seq);
      writePose(w, m);
      break;
    case 'ping':
      w.u8(C2S.PING).f64(m.clientTime);
      break;
    case 'enter_vehicle':
      w.u8(C2S.ENTER_VEHICLE).u16(m.vehicle);
      break;
    case 'exit_vehicle':
      w.u8(C2S.EXIT_VEHICLE);
      break;
    case 'shot':
      w.u8(C2S.SHOT).u16(m.seq).u8(m.weapon).u32(m.viewTime);
      w.i24(qPos(m.x)).i16(qY(m.y)).i24(qPos(m.z)).u16(qYaw(m.yaw)).i16(qPitch(m.pitch));
      break;
    case 'chat':
      w.u8(C2S.CHAT).str(m.text);
      break;
    case 'emote':
      w.u8(C2S.EMOTE).u8(m.emote);
      break;
    case 'job':
      w.u8(C2S.JOB).u8(m.op).u16(m.point);
      break;
    case 'call_car':
      w.u8(C2S.CALL_CAR).u16(m.point).u32(m.car);
      break;
    case 'taxi':
      w.u8(C2S.TAXI).i24(qPos(m.x)).i24(qPos(m.z));
      break;
    case 'service':
      w.u8(C2S.SERVICE).u16(m.point).u8(m.what);
      break;
    case 'equip':
      w.u8(C2S.EQUIP).u8(m.weapon);
      break;
    case 'reload':
      w.u8(C2S.RELOAD);
      break;
    case 'buy':
      w.u8(C2S.BUY).u16(m.point).u8(m.item);
      break;
    case 'revive':
      w.u8(C2S.REVIVE).u16(m.target);
      break;
    case 'act':
      w.u8(C2S.ACT).u8(m.what).u16(m.arg);
      break;
  }
  return w.done();
}

export function decodeClient(bytes: Uint8Array): ClientMessage {
  const r = new Reader(bytes);
  const type = r.u8();
  let m: ClientMessage;
  switch (type) {
    case C2S.HELLO:
      m = { type: 'hello', version: r.u16(), name: r.str(32), token: r.str(4096) };
      break;
    case C2S.STATE:
      m = { type: 'state', seq: r.u16(), ...readPose(r) };
      break;
    case C2S.PING:
      m = { type: 'ping', clientTime: r.f64() };
      break;
    case C2S.ENTER_VEHICLE:
      m = { type: 'enter_vehicle', vehicle: r.u16() };
      break;
    case C2S.EXIT_VEHICLE:
      m = { type: 'exit_vehicle' };
      break;
    case C2S.SHOT:
      m = {
        type: 'shot',
        seq: r.u16(),
        weapon: r.u8(),
        viewTime: r.u32(),
        x: r.i24() / POS_SCALE,
        y: r.i16() / POS_SCALE,
        z: r.i24() / POS_SCALE,
        yaw: dqYaw(r.u16()),
        pitch: r.i16() / PITCH_SCALE,
      };
      break;
    case C2S.CHAT:
      // UTF-8: up to 4 bytes a character.
      m = { type: 'chat', text: r.str(CHAT.MAX_CHARS * 4) };
      break;
    case C2S.EMOTE:
      m = { type: 'emote', emote: r.u8() };
      break;
    case C2S.JOB:
      m = { type: 'job', op: r.u8(), point: r.u16() };
      break;
    case C2S.CALL_CAR:
      m = { type: 'call_car', point: r.u16(), car: r.u32() };
      break;
    case C2S.TAXI:
      m = { type: 'taxi', x: r.i24() / POS_SCALE, z: r.i24() / POS_SCALE };
      break;
    case C2S.SERVICE:
      m = { type: 'service', point: r.u16(), what: r.u8() };
      break;
    case C2S.EQUIP:
      m = { type: 'equip', weapon: r.u8() };
      break;
    case C2S.RELOAD:
      m = { type: 'reload' };
      break;
    case C2S.BUY:
      m = { type: 'buy', point: r.u16(), item: r.u8() };
      break;
    case C2S.REVIVE:
      m = { type: 'revive', target: r.u16() };
      break;
    case C2S.ACT:
      m = { type: 'act', what: r.u8(), arg: r.u16() };
      break;
    default:
      throw new DecodeError(`unknown client message ${type}`);
  }
  r.end();
  return m;
}

/**
 * Builds a snapshot straight into a writer, entity by entity, so the world server allocates
 * nothing per client per tick. 17 bytes per entity. `begin` appends at the writer's current
 * position, so a snapshot can follow other messages in the same frame.
 */
export class SnapshotEncoder {
  readonly w: Writer;
  private countAt = 0;
  private count = 0;

  constructor(w = new Writer(4096)) {
    this.w = w;
  }

  begin(serverTime: number): this {
    this.w.u8(S2C.SNAPSHOT).u32(serverTime);
    this.countAt = this.w.length;
    this.w.u16(0);
    this.count = 0;
    return this;
  }

  /** Appends one entity. Takes the id apart from the pose so callers need not allocate. */
  entity(id: number, e: Omit<EntityUpdate, 'id'>): this {
    this.w.u16(id).i24(qPos(e.x)).i16(qY(e.y)).i24(qPos(e.z)).u16(qYaw(e.yaw));
    this.w.i16(qVel(e.vx)).i16(qVel(e.vz)).u8(e.state);
    this.count += 1;
    return this;
  }

  get entities(): number {
    return this.count;
  }

  /** Patches the count; returns a view of everything in the writer (valid until next write). */
  finish(): Uint8Array<ArrayBuffer> {
    this.w.patchU16(this.countAt, this.count);
    return this.w.peek();
  }
}

/**
 * A server frame carries one or more messages back to back: the world sends each client one
 * frame per tick (entries leaving and entering view, then the snapshot) to save syscalls.
 */
export function encodeServer(m: ServerMessage, w = new Writer(128)): Uint8Array<ArrayBuffer> {
  w.reset();
  writeServer(m, w);
  return w.done();
}

/** Appends one message to `w` without resetting it. */
export function writeServer(m: ServerMessage, w: Writer): void {
  switch (m.type) {
    case 'welcome':
      w.u8(S2C.WELCOME).u16(m.version).u16(m.you).f64(m.serverTime);
      w.f64(m.clock.realMs).f64(m.clock.gameMinutes).f32(m.clock.rate);
      writePose(w, m.spawn);
      break;
    case 'snapshot': {
      const s = new SnapshotEncoder(w).begin(m.serverTime);
      for (const e of m.entities) s.entity(e.id, e);
      s.finish();
      break;
    }
    case 'enter':
      w.u8(S2C.ENTER)
        .u16(m.id)
        .u8(m.kind)
        .u8(m.model)
        .u8(m.variant)
        .str(m.name)
        .u32(m.look)
        .u32(m.gear)
        .u8(m.faction ?? 0)
        .u8(Math.min(255, m.level ?? 0));
      break;
    case 'leave':
      w.u8(S2C.LEAVE).u16(m.id);
      break;
    case 'pong':
      w.u8(S2C.PONG).f64(m.clientTime).f64(m.serverTime);
      break;
    case 'clock':
      w.u8(S2C.CLOCK).f64(m.realMs).f64(m.gameMinutes).f32(m.rate);
      break;
    case 'seat':
      w.u8(S2C.SEAT).u16(m.vehicle).u16(m.driver);
      break;
    case 'correction':
      w.u8(S2C.CORRECTION).u16(m.seq);
      writePose(w, m);
      break;
    case 'shot_fx':
      w.u8(S2C.SHOT_FX).u16(m.shooter).u8(m.weapon);
      w.i24(qPos(m.x)).i16(qY(m.y)).i24(qPos(m.z)).u16(qYaw(m.yaw)).i16(qPitch(m.pitch));
      w.u16(m.distance < 0 ? 0xffff : clamp(Math.round(m.distance * 10), 0, 0xfffe));
      break;
    case 'hit':
      w.u8(S2C.HIT).u16(m.target).u16(m.shooter).u8(m.zone).u8(m.damage).u8(m.hp);
      break;
    case 'health':
      w.u8(S2C.HEALTH)
        .u8(m.hp)
        .u8(m.downed ? 1 : 0);
      break;
    case 'error':
      w.u8(S2C.ERROR).u8(m.code).str(m.message);
      break;
    case 'voice':
      w.u8(S2C.VOICE).str(m.url).str(m.token);
      break;
    case 'chat':
      w.u8(S2C.CHAT).u16(m.from).str(m.text);
      break;
    case 'emote':
      w.u8(S2C.EMOTE).u16(m.from).u8(m.emote);
      break;
    case 'job':
      w.u8(S2C.JOB).str(m.state);
      break;
    case 'reward':
      w.u8(S2C.REWARD).u32(m.cents).u16(m.xp).u32(m.totalXp).str(m.reason);
      break;
    case 'ride':
      w.u8(S2C.RIDE)
        .u8(Math.round(m.seconds * 10))
        .u32(m.cents)
        .str(m.text);
      break;
    case 'car':
      w.u8(S2C.CAR).u16(m.vehicle).u8(qUnit(m.fuel)).u8(qUnit(m.health));
      break;
    case 'arms':
      w.u8(S2C.ARMS).str(m.state);
      break;
    case 'dispatch':
      w.u8(S2C.DISPATCH).str(m.state);
      break;
  }
}

/** Decodes a frame holding exactly one message. */
export function decodeServer(bytes: Uint8Array): ServerMessage {
  const r = new Reader(bytes);
  const m = readServer(r);
  r.end();
  return m;
}

/** Decodes every message in a frame, in order. */
export function decodeServerFrame(bytes: Uint8Array): ServerMessage[] {
  const r = new Reader(bytes);
  const out: ServerMessage[] = [];
  do out.push(readServer(r));
  while (!r.atEnd());
  return out;
}

function readServer(r: Reader): ServerMessage {
  const type = r.u8();
  let m: ServerMessage;
  switch (type) {
    case S2C.WELCOME:
      m = {
        type: 'welcome',
        version: r.u16(),
        you: r.u16(),
        serverTime: r.f64(),
        clock: { realMs: r.f64(), gameMinutes: r.f64(), rate: r.f32() },
        spawn: readPose(r),
      };
      break;
    case S2C.SNAPSHOT: {
      const serverTime = r.u32();
      const n = r.u16();
      const entities: EntityUpdate[] = [];
      for (let i = 0; i < n; i += 1) {
        entities.push({
          id: r.u16(),
          x: r.i24() / POS_SCALE,
          y: r.i16() / POS_SCALE,
          z: r.i24() / POS_SCALE,
          yaw: dqYaw(r.u16()),
          vx: r.i16() / VEL_SCALE,
          vz: r.i16() / VEL_SCALE,
          state: r.u8(),
        });
      }
      m = { type: 'snapshot', serverTime, entities };
      break;
    }
    case S2C.ENTER:
      m = {
        type: 'enter',
        id: r.u16(),
        kind: r.u8(),
        model: r.u8(),
        variant: r.u8(),
        name: r.str(64),
        look: r.u32(),
        gear: r.u32(),
        faction: r.u8(),
        level: r.u8(),
      };
      break;
    case S2C.LEAVE:
      m = { type: 'leave', id: r.u16() };
      break;
    case S2C.PONG:
      m = { type: 'pong', clientTime: r.f64(), serverTime: r.f64() };
      break;
    case S2C.CLOCK:
      m = { type: 'clock', realMs: r.f64(), gameMinutes: r.f64(), rate: r.f32() };
      break;
    case S2C.SEAT:
      m = { type: 'seat', vehicle: r.u16(), driver: r.u16() };
      break;
    case S2C.CORRECTION:
      m = { type: 'correction', seq: r.u16(), ...readPose(r) };
      break;
    case S2C.SHOT_FX: {
      const shooter = r.u16();
      const weapon = r.u8();
      const x = r.i24() / POS_SCALE;
      const y = r.i16() / POS_SCALE;
      const z = r.i24() / POS_SCALE;
      const yaw = dqYaw(r.u16());
      const pitch = r.i16() / PITCH_SCALE;
      const d = r.u16();
      m = {
        type: 'shot_fx',
        shooter,
        weapon,
        x,
        y,
        z,
        yaw,
        pitch,
        distance: d === 0xffff ? -1 : d / 10,
      };
      break;
    }
    case S2C.HIT:
      m = {
        type: 'hit',
        target: r.u16(),
        shooter: r.u16(),
        zone: r.u8(),
        damage: r.u8(),
        hp: r.u8(),
      };
      break;
    case S2C.HEALTH:
      m = { type: 'health', hp: r.u8(), downed: r.u8() === 1 };
      break;
    case S2C.ERROR:
      m = { type: 'error', code: r.u8(), message: r.str(256) };
      break;
    case S2C.VOICE:
      m = { type: 'voice', url: r.str(256), token: r.str(4096) };
      break;
    case S2C.CHAT:
      m = { type: 'chat', from: r.u16(), text: r.str(CHAT.MAX_CHARS * 4) };
      break;
    case S2C.EMOTE:
      m = { type: 'emote', from: r.u16(), emote: r.u8() };
      break;
    case S2C.JOB:
      m = { type: 'job', state: r.str(8192) };
      break;
    case S2C.REWARD:
      m = { type: 'reward', cents: r.u32(), xp: r.u16(), totalXp: r.u32(), reason: r.str(512) };
      break;
    case S2C.RIDE:
      m = { type: 'ride', seconds: r.u8() / 10, cents: r.u32(), text: r.str(512) };
      break;
    case S2C.CAR:
      m = { type: 'car', vehicle: r.u16(), fuel: r.u8() / 255, health: r.u8() / 255 };
      break;
    case S2C.ARMS:
      m = { type: 'arms', state: r.str(2048) };
      break;
    case S2C.DISPATCH:
      m = { type: 'dispatch', state: r.str(8192) };
      break;
    default:
      throw new DecodeError(`unknown server message ${type}`);
  }
  return m;
}
