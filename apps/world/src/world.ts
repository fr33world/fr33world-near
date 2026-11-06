/**
 * The authoritative world for one server (Horizon). It owns sessions, the game clock, vehicle
 * seats and every entity's accepted pose, validates the poses clients report, and sends each
 * client a tiered snapshot of what is near it (technical-plan §6):
 *
 * - the nearest NEAR_MAX bodies within NEAR_RADIUS every tick (30 Hz),
 * - the nearest MID_MAX within MID_RADIUS every second tick (15 Hz),
 * - the rest of the nearest VIEW_MAX within VIEW_RADIUS every sixth tick (5 Hz),
 *
 * and only when they changed, plus a keepalive. A whole crowd in one plaza therefore costs each
 * client a bounded number of entities.
 *
 * The per-tick view update is the hot path (500 viewers × hundreds of candidates, 30 times a
 * second), so entity positions, versions and visibility are mirrored in flat typed arrays
 * indexed by entity id, and each player's view is a compact set of typed arrays.
 */
import {
  CollisionIndex,
  type CityLayout,
  type District,
  districtAt,
  generateCity,
  canReach,
  type Bed,
  BED_Y,
  DOOR,
  interiorAt,
  INTERIORS,
  isWalkable,
  dropOff,
  type HeightRange,
  heightRange,
  lotHeight,
  RoadGraph,
  type Rect,
  type Seat,
  SEAT_REACH_M,
  SEAT_STEP_M,
  type ServiceId,
} from '@fr33world/city';
import {
  ACT,
  CHAT,
  type ClientMessage,
  EMOTES,
  JOB_OP,
  qUnit,
  SERVICE,
  WEAPON,
  decodeClient,
  ENTITY_KIND,
  ERROR_CODE,
  encodeServer,
  FLAG,
  HIT_ZONE,
  MODE,
  modeOf,
  NO_ENTITY,
  type Pose,
  PROTOCOL_VERSION,
  type ServerMessage,
  SnapshotEncoder,
  Writer,
  writeServer,
} from '@fr33world/protocol';
import {
  AOI,
  BAGS,
  CAR_MODELS,
  CLOCK_EPOCH,
  type ClockAnchor,
  CLOTHES_COLOURS,
  crashDamage,
  DAMAGE,
  FUEL,
  fuelCost,
  repairCost,
  DEALER_MODELS,
  DEFAULT_APPEARANCE,
  rideDistance,
  rideSeconds,
  TAXI,
  taxiFare,
  DOWNED_SECONDS,
  encodeAppearance,
  encodeGear,
  EYEWEAR,
  gameMinutesAt,
  HEADWEAR,
  LAG_COMP_MAX_MS,
  MAX_HP,
  MUZZLE_TOLERANCE,
  NECKWEAR,
  NO_GEAR,
  reanchor,
  ROCKETBOX_FACES,
  ROCKETBOX_OUTFITS,
  SHOOT_HEIGHT,
  SKIN_TONES,
  type Staff,
  ARMORY,
  type FactionId,
  FACTIONS,
  factionCode,
  ON_DUTY_BIT,
  hasPower,
  isFactionId,
  type Membership,
  rankOf,
  SALARY,
  type Arms,
  FALL,
  fallDamage,
  CARE,
  CONSUMABLES,
  GOODS,
  HOSPITAL_FEE,
  MEDICAL,
  NO_ARMS,
  TICK_HZ,
  VEHICLE_ENTER_RADIUS,
  WEAPONS,
  WRISTWEAR,
  levelOf,
} from '@fr33world/shared';
import { type ApiPath, type CommandWorld, parse, parseCents, runCommand } from './commands.ts';
import { collect } from './jobs/collect.ts';
import { courier } from './jobs/courier.ts';
import { haul } from './jobs/haul.ts';
import { type JobDef, type JobHost, type JobPlayer, Jobs, type Saved } from './jobs/jobs.ts';
import { mining } from './jobs/mining.ts';
import { taxi } from './jobs/taxi.ts';
import { direction, hitCharacter, PoseHistory, type Vec3, type Zone } from './combat.ts';
import { selectInPlace, SpatialGrid } from './grid.ts';
import type { Conn } from './transport.ts';
import type { VoiceIssuer } from './voice.ts';
import { FOOT_LIMITS, MoveValidator, VEHICLE_LIMITS } from './validate.ts';

/** Where a character comes back (the API keeps it). */
interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A verified player: their account, and their real name when the token carries it. */
export interface Identity {
  account: string;
  name?: string;
  /** The character's appearance (shared `encodeAppearance`), from the ticket. */
  look?: number;
  /** What the character wears besides the outfit (shared `encodeGear`), from the ticket. */
  gear?: number;
  /** Staff: their role and powers, from the ticket. */
  staff?: Staff;
  /** The character's experience, from the ticket. */
  xp?: number;
}

export interface WorldOptions {
  maxPlayers?: number;
  /** How often the host calls step() (default TICK_HZ); only used for tick statistics. */
  tickHz?: number;
  now?: () => number;
  city?: CityLayout;
  /**
   * Game time at start, in minutes since midnight of day 0 (tests). By default the clock
   * follows CLOCK_EPOCH, so it survives restarts.
   */
  startGameMinutes?: number;
  clockRate?: number;
  /** Fills the kerbs round the plaza with cars anyone may drive (tests). */
  streetCars?: boolean;
  /** Areas where weapons don't work (default: the spawn plaza). */
  safeZones?: Rect[];
  /**
   * Verifies a login token (a world ticket or a Privy token) and returns who it is, or null.
   * Without it (tests, bots, local dev without keys) tokens are not checked.
   */
  authenticate?: (token: string) => Promise<Identity | null>;
  /** Refuse players without a valid token (production). */
  requireAuth?: boolean;
  /**
   * Lasting staff changes and the audit log, through the API (main.ts: the internal routes);
   * none = staff commands that need it say they aren't available.
   */
  staffApi?: (path: ApiPath | 'audit', body: Record<string, unknown>) => Promise<unknown>;
  /** Issues each player a proximity-voice pass after the welcome (voice.ts); none = no voice. */
  voice?: VoiceIssuer;
}

/** `text` cut (at a character) to at most `max` bytes of UTF-8, as chat lines are read. */
function fitBytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = '';
  let n = 0;
  for (const ch of text) {
    n += enc.encode(ch).length;
    if (n > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

/** The car every player starts with (shared CAR_MODELS: the Compact). */
const STARTER_CAR = Math.max(
  0,
  CAR_MODELS.findIndex((m) => m.id === 'compact'),
);

/** Districts as players know them. */
function districtName(d: District): string {
  const names: Record<District, string> = {
    downtown: 'Downtown',
    arts: 'the Arts District',
    mid_city: 'Mid City',
    palm_heights: 'Palm Heights',
    south_grid: 'South Grid',
    eastside: 'Eastside',
    port: 'the Port',
    hills: 'the hills',
    beach: 'Beach',
    quarry: 'the quarry',
    river: 'the river',
    medical: 'the Medical Center',
    stadium_hill: 'the stadium',
  };
  return names[d] ?? d;
}

/** How long a disconnected player's body waits for them to reconnect (ms). */
export const GHOST_MS = 60_000;
/** A ghost's connection: sends go nowhere. */
const NO_CONN: Conn = {
  id: -1,
  remote: 'ghost',
  send: () => {},
  buffered: () => 0,
  close: () => {},
};

/** Chat flood control: messages in a burst, then one every this many ms. */
const CHAT_BURST = 4;
const CHAT_EVERY_MS = 1500;

/** Control characters, zero-width spaces and text-direction overrides. */
// eslint-disable-next-line no-control-regex
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** A chat line made safe to show: no control characters, spaces squeezed, trimmed, capped. */
export function cleanChat(raw: string): string {
  const flat = raw.replace(UNSHOWABLE, ' ');
  const squeezed = flat.replace(/\s+/g, ' ').trim();
  return [...squeezed].slice(0, CHAT.MAX_CHARS).join('');
}

/** A stable, varied look for a player without a character (bots, local play). */
function madeUpLook(id: number): number {
  const h = Math.imul(id ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  const body = h & 1 ? 'female' : 'male';
  return encodeAppearance({
    ...DEFAULT_APPEARANCE,
    body,
    face: (h >>> 1) % ROCKETBOX_FACES[body].length,
    outfit: (h >>> 6) % ROCKETBOX_OUTFITS[body].length,
    skin: (h >>> 11) % (SKIN_TONES.length + 1),
    top: (h >>> 14) % 3,
  });
}

/** Some accessories for a player without a character (bots, local play), from the id. */
function madeUpGear(id: number): number {
  const h = Math.imul(id ^ 0x2545f491, 0x9e3779b1) >>> 0;
  return encodeGear({
    ...NO_GEAR,
    head: h % 3 === 0 ? 1 + ((h >>> 2) % (HEADWEAR.length - 1)) : 0,
    eyes: h % 4 === 1 ? 1 + ((h >>> 5) % (EYEWEAR.length - 1)) : 0,
    neck: h % 5 === 2 ? 1 + ((h >>> 8) % (NECKWEAR.length - 1)) : 0,
    wrist: (h >>> 11) % 2 ? 1 + ((h >>> 12) % (WRISTWEAR.length - 1)) : 0,
    bag: h % 6 === 3 ? 1 + ((h >>> 14) % (BAGS.length - 1)) : 0,
    headColour: (h >>> 16) % CLOTHES_COLOURS.length,
    bagColour: (h >>> 19) % CLOTHES_COLOURS.length,
  });
}

/** The entities one player currently has in view, with what was last sent for each. */
class ViewSet {
  static readonly CAP = AOI.VIEW_KEEP + 8;
  readonly ids = new Uint16Array(ViewSet.CAP);
  readonly lastTick = new Int32Array(ViewSet.CAP);
  readonly version = new Uint32Array(ViewSet.CAP);
  /** Send interval in ticks for each slot (its tier), set at the last rebuild. */
  readonly every = new Uint8Array(ViewSet.CAP);
  count = 0;

  has(id: number): boolean {
    for (let s = 0; s < this.count; s += 1) if (this.ids[s] === id) return true;
    return false;
  }
}

interface Player {
  id: number;
  conn: Conn;
  /** Login account (Privy user id), or null when playing unauthenticated in dev. */
  account: string | null;
  name: string;
  /** Appearance code everyone draws them with. */
  look: number;
  gear: number;
  pose: Pose;
  seq: number;
  vehicle: number;
  hp: number;
  view: ViewSet;
  /** Set when the view must be rebuilt on the next tick (joined, or placed by the server). */
  rebuild: boolean;
  validator: MoveValidator;
  /** After a correction, reports far from the corrected pose are dropped until this time. */
  correctionUntil: number;
  strikes: number;
  strikesAt: number;
  lastPingAt: number;
  badMessages: number;
  /** Message allowance left (token bucket), when it was last refilled, and messages dropped. */
  msgTokens: number;
  msgAt: number;
  dropped: number;
  /** Recent positions for lag-compensated hit tests. */
  history: PoseHistory;
  lastShotAt: number;
  /** Chat flood control: tokens (a message each), refilled over time. */
  chatTokens: number;
  chatAt: number;
  emoteAt: number;
  /** Staff role and powers (from the ticket), or null. */
  staff: Staff | null;
  /** Experience (from the ticket, then each reward's new total). */
  xp: number;
  /** Chat muted by an admin until this time; the last /help (ms). */
  chatMutedUntil: number;
  /**
   * What they carry (the API's armoury), the weapon in hand, each weapon's magazine, when a
   * reload finishes, rounds fired not yet told to the API, and whether checks apply (logged-in
   * players with an API; anonymous local play isn't checked).
   */
  arms: Arms;
  /** Police on duty: the duty pistol's rounds (not theirs to keep), and whether it's on loan. */
  dutyRounds: number;
  dutyPistol: boolean;
  /** Their faction (the API's), on duty or not, active duty time towards the next pay. */
  membership: Membership | null;
  onDuty: boolean;
  dutyMs: number;
  /** When they last moved (for pay: on duty but away doesn't count). */
  movedAt: number;
  /** Their last shots-fired call (so a gunfight isn't a hundred calls). */
  shotsCalledAt: number;
  inHand: number;
  mag: Record<number, number>;
  reloadUntil: number;
  spent: Record<number, number>;
  armed: boolean;
  /** When they last called their car, took a taxi, and were hurt (ms). */
  carCalledAt: number;
  rideAt: number;
  hurtAt: number;
  helpAt: number;
  /** Disconnected, waiting for a reconnect until this time (0: connected). */
  ghostUntil: number;
  /**
   * While downed: when they wake in a hospital bed (ms, world clock); in a bed: when they're
   * healed. Else 0.
   */
  downedUntil: number;
  /** Their hospital bed (index into INTERIORS.hospital.beds), else -1. */
  bed: number;
  /** When they got into it, for the healing (ms). */
  bedFrom: number;
  /** Called EMS while down. */
  emsCalled: boolean;
  /** Fell out of a moving car: on the ground until then (ms), else 0. */
  fallUntil: number;
  /** The seat they're sitting on (each room's `seats`). */
  seat: Seat | null;
  /** Where they stood at the last save of their place, to rounded metres. */
  placeSaved: string;
}

interface Vehicle {
  id: number;
  model: number;
  color: number;
  pose: Pose;
  driver: number;
  /** A player's own car (called at a car park): whose (account, or `anon:<id>` in local play), and their name. */
  owner?: string;
  ownerName?: string;
  /** A player's own car: its id in the API's garage. A street car: its spawn (city index). */
  carId?: number;
  /** A rental: when it's due back (ms since 1970); it goes back then, once nobody's in it. */
  dueAt?: number;
  spawn?: number;
  /** Fuel and condition, 0–1 (shared car-condition), and what its driver and owner last heard. */
  fuel: number;
  health: number;
  heard: { fuel: number; health: number; at: number };
  /** The speed and time of its last driven report (crash detection), and since when it's sat empty. */
  lastSpeed: number;
  lastAt: number;
  idleSince: number;
}

/** A car fresh from its spawn or the garage. */
const fresh = (fuel = 1, health = 1) => ({
  fuel,
  health,
  heard: { fuel: -1, health: -1, at: -Infinity },
  lastSpeed: 0,
  lastAt: 0,
  idleSince: 0,
});

/** The driver's flags a car keeps (the horn, lights); the server sets DAMAGED and WRECKED. */
const DRIVER_FLAGS = FLAG.HORN | FLAG.LIGHTS;
/** A street car left empty or wrecked goes back to its spawn after this long (ms). */
const STREET_CAR_RESET_MS = 180_000;

/** Chat commands the factions use (Phase 9), run by the world rather than commands.ts. */
const FACTION_COMMANDS = new Set([
  '911',
  'ems',
  'duty',
  'respond',
  'resolve',
  'f',
  'vehicle',
  'accept',
  'reject',
  'interview',
  'promote',
  'demote',
  'dismiss',
  'boss',
  'id',
  'fine',
]);

/** The owner of the cars on show at the dealership: nobody drives them. */
const ON_SHOW = 'dealer';

interface Pending {
  conn: Conn;
  openedAt: number;
  /** A token check is in flight. */
  authing: boolean;
}

/**
 * Entity ids handed out first-in first-out, so a freed id is not reused until every other id
 * has been: a viewer can never confuse a newcomer with whoever held the id a moment ago.
 */
class IdPool {
  private readonly ring: Uint16Array;
  private head = 0;
  private size: number;

  constructor(max: number) {
    this.ring = new Uint16Array(max);
    for (let i = 0; i < max; i += 1) this.ring[i] = i + 1;
    this.size = max;
  }

  take(): number {
    if (this.size === 0) throw new Error('out of entity ids');
    const id = this.ring[this.head] as number;
    this.head = (this.head + 1) % this.ring.length;
    this.size -= 1;
    return id;
  }

  release(id: number): void {
    this.ring[(this.head + this.size) % this.ring.length] = id;
    this.size += 1;
  }
}

export interface WorldStats {
  players: number;
  ticks: number;
  tickMsP50: number;
  tickMsP95: number;
  tickMsP99: number;
  tickMsMax: number;
  bytesOut: number;
  framesOut: number;
  messagesIn: number;
  corrections: number;
  skippedSlow: number;
  kicks: number;
  /** Messages dropped by the per-player rate limit. */
  dropped: number;
}

const HELLO_TIMEOUT_MS = 5000;
const SLOW_CLIENT_BYTES = 512 * 1024;
const VIEW_HYSTERESIS = 20;
const CORRECTION_WINDOW_MS = 600;
/** How long logging in waits for the API's word on where they were (ms). */
const PLACE_WAIT_MS = 2_500;
/** Which way round a seat to get up, first that's clear: forward, back, a side. */
const SEAT_SIDES = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
/** How much room a body needs at the place it comes back to (m). */
const PLACE_CLEAR_M = 0.3;
/** How near a building's door a service vehicle can be called (m). */
const VEHICLE_REACH_M = 60;
/** Up from a hospital bed: how far from its middle you stand (m). */
const BED_STEP_M = 1.9;
const CORRECTION_ACCEPT_RADIUS = 3;
const STRIKE_DECAY_MS = 10_000;
const STRIKE_KICK = 25;
const MAX_BAD_MESSAGES = 5;
/**
 * Message allowance per player (token bucket): normal play sends about 21 a second (20 state
 * reports, pings) and up to ~31 firing the rifle. Beyond the burst, messages are dropped;
 * a client that keeps flooding is disconnected.
 */
const MSG_RATE = 60;
const MSG_BURST = 120;
const MAX_DROPPED = 300;
const MAX_ENTITIES = 0xfffe;
const ID_SPACE = 0x10000;
/**
 * Views are rebuilt (candidates, tiers, enter/leave) every this many ticks, staggered across
 * players; ticks in between only send what is due from the existing view.
 */
const REBUILD_EVERY = 3;

const idle = (x: number, y: number, z: number, yaw: number): Pose => ({
  x,
  y,
  z,
  yaw,
  vx: 0,
  vy: 0,
  vz: 0,
  state: MODE.IDLE,
});

const freshCounters = () => ({
  bytesOut: 0,
  framesOut: 0,
  messagesIn: 0,
  corrections: 0,
  skippedSlow: 0,
  kicks: 0,
  dropped: 0,
  ticks: 0,
});

export class World {
  readonly city: CityLayout;
  readonly collision: CollisionIndex;
  /** The ground and highest walkable surface at a point (movement height checks). */
  readonly heights = (x: number, z: number): HeightRange => heightRange(this.city, x, z);
  private readonly staffApi: WorldOptions['staffApi'];
  /** Jobs (jobs/): courier and mining shifts, their state and pay. */
  private readonly jobs: Jobs;
  /** Accounts banned while online, until when (ms): kept out though their ticket is good. */
  private readonly barred = new Map<string, number>();
  private readonly maxPlayers: number;
  private readonly tickHz: number;
  private readonly voice: VoiceIssuer | undefined;
  private readonly safeZones: Rect[];
  private readonly authenticate: WorldOptions['authenticate'];
  private readonly requireAuth: boolean;
  private readonly now: () => number;
  private readonly startedAt: number;
  private clock: ClockAnchor;

  private readonly pending = new Map<number, Pending>();
  private readonly players = new Map<number, Player>();
  private readonly byConn = new Map<number, Player>();
  private readonly vehicles = new Map<number, Vehicle>();
  private readonly idPool = new IdPool(MAX_ENTITIES);
  private readonly grid = new SpatialGrid(100);

  // Entity mirrors, indexed by entity id.
  private readonly poses: (Pose | undefined)[] = new Array<Pose | undefined>(ID_SPACE);
  private readonly ex = new Float64Array(ID_SPACE);
  private readonly ez = new Float64Array(ID_SPACE);
  private readonly ever = new Uint32Array(ID_SPACE);
  /** 1 when the entity is drawn in snapshots (seated players are drawn by their car). */
  private readonly evisible = new Uint8Array(ID_SPACE);

  private tickNo = 0;
  private spawnCursor = 0;

  // Scratch space reused every tick.
  private readonly candidates: number[] = [];
  private readonly ids = new Uint16Array(ID_SPACE);
  private readonly dist2 = new Float64Array(ID_SPACE);
  private readonly scratch = new Float64Array(ID_SPACE);
  private readonly slotOf = new Int16Array(ID_SPACE);
  private readonly slotGen = new Uint32Array(ID_SPACE);
  private slotGenNo = 0;
  private readonly keep = new Uint8Array(ViewSet.CAP);
  private readonly newIds = new Uint16Array(ViewSet.CAP);
  private readonly newVersions = new Uint32Array(ViewSet.CAP);
  private readonly newEvery = new Uint8Array(ViewSet.CAP);
  private readonly snapWriter = new Writer(8192);
  private readonly snapshot = new SnapshotEncoder(this.snapWriter);
  private readonly pre = new Writer(1024);
  private readonly frame = new Writer(16384);
  private readonly writer = new Writer(256);

  private readonly tickTimes: number[] = [];
  private counters = freshCounters();

  constructor(options: WorldOptions = {}) {
    this.maxPlayers = options.maxPlayers ?? 500;
    this.tickHz = options.tickHz ?? TICK_HZ;
    this.now = options.now ?? (() => Date.now());
    this.city = options.city ?? generateCity();
    this.safeZones = options.safeZones ?? [this.city.plaza];
    this.authenticate = options.authenticate;
    this.requireAuth = options.requireAuth ?? false;
    this.voice = options.voice;
    this.staffApi = options.staffApi;
    this.jobs = new Jobs(this.jobHost(), [
      courier,
      mining,
      taxi,
      collect,
      haul,
    ] as JobDef<unknown>[]);
    this.collision = CollisionIndex.fromCity(this.city);
    this.startedAt = this.now();
    const rate = options.clockRate ?? CLOCK_EPOCH.rate;
    this.clock =
      options.startGameMinutes === undefined
        ? reanchor(CLOCK_EPOCH, this.startedAt, rate)
        : { realMs: this.startedAt, gameMinutes: options.startGameMinutes, rate };
    // None by default (owner, 2026-11-02): cars are rented, bought or come with the job.
    (options.streetCars ? this.city.vehicleSpawns : []).forEach((spawn, i) => {
      const id = this.allocId();
      const v: Vehicle = {
        id,
        model: spawn.model,
        color: spawn.color,
        pose: idle(spawn.x, 0, spawn.z, spawn.yaw),
        driver: NO_ENTITY,
        spawn: i,
        ...fresh(),
      };
      this.vehicles.set(id, v);
      this.track(id, v.pose, true);
    });
    // The cars for sale, on show on the dealership's forecourt.
    const shop = this.city.dealership;
    shop?.display.forEach((spot, i) => {
      const model = DEALER_MODELS[i];
      if (model === undefined) return;
      const id = this.allocId();
      const v: Vehicle = {
        id,
        model,
        color: 0,
        pose: idle(spot.x, lotHeight(this.city, shop.rect), spot.z, spot.yaw),
        driver: NO_ENTITY,
        owner: ON_SHOW,
        ...fresh(),
      };
      this.vehicles.set(id, v);
      this.track(id, v.pose, true);
    });
  }

  get playerCount(): number {
    return this.players.size;
  }

  get capacity(): number {
    return this.maxPlayers;
  }

  /** Milliseconds since the world started, as sent in snapshots and pongs. */
  serverTime(): number {
    return Math.round(this.now() - this.startedAt);
  }

  /** The clock as clients receive it: anchored now, on the server-time timeline. */
  clockAnchor(): ClockAnchor {
    return { realMs: this.serverTime(), gameMinutes: this.gameMinutes(), rate: this.clock.rate };
  }

  gameMinutes(): number {
    return gameMinutesAt(this.clock, this.now());
  }

  setClockRate(rate: number): void {
    this.clock = reanchor(this.clock, this.now(), rate);
    const msg = encodeServer({ type: 'clock', ...this.clockAnchor() }, this.writer);
    for (const p of this.players.values()) this.send(p.conn, msg);
  }

  // ---- transport callbacks -------------------------------------------------------------

  open(conn: Conn): void {
    this.pending.set(conn.id, { conn, openedAt: this.now(), authing: false });
  }

  close(conn: Conn): void {
    this.pending.delete(conn.id);
    const p = this.byConn.get(conn.id);
    if (!p) return;
    this.byConn.delete(conn.id);
    // Dropped at the wheel: the body comes out beside the car, not where they got in.
    const car = this.vehicles.get(p.vehicle);
    if (car) Object.assign(p.pose, this.besideCar(car));
    if (p.seat) {
      Object.assign(p.pose, this.frontOf(p.seat));
      p.seat = null;
    }
    if (p.vehicle !== NO_ENTITY) this.releaseSeat(p);
    // A logged-in player's connection dropped: their body stays a while (a ghost, standing
    // still), so a reconnect within GHOST_MS takes up the same character where it was.
    if (p.account !== null) {
      p.conn = NO_CONN;
      p.ghostUntil = this.now() + GHOST_MS;
      p.pose.vx = p.pose.vy = p.pose.vz = 0;
      p.pose.state = (p.pose.state & 0xf0 & ~FLAG.TALKING) | MODE.IDLE;
      this.moved(p.id, p.pose);
      return;
    }
    this.remove(p);
  }

  /** Takes a player out of the world for good. */
  private remove(p: Player) {
    this.jobs.left(p.id);
    this.closeIncidentsOf(p.id);
    this.flushRounds(p);
    void this.savePlaces([p]);
    // Their own car goes back to the garage with them (unless someone's in it).
    const own = this.ownCar(this.ownerKey(p));
    if (own && own.driver === NO_ENTITY) this.garageCar(own);
    this.players.delete(p.id);
    this.untrack(p.id);
    this.idPool.release(p.id);
  }

  /**
   * A reconnect within GHOST_MS: the ghost gets the new connection and carries on where it
   * was (place, health, a pending respawn), with a fresh view so everything is sent again.
   */
  private resume(
    conn: Conn,
    p: Player,
    rawName: string,
    look?: number,
    gear?: number,
    staff?: Staff,
    xp?: number,
  ) {
    const now = this.now();
    p.conn = conn;
    p.staff = staff ?? null;
    if (xp !== undefined) p.xp = Math.max(p.xp, xp);
    p.ghostUntil = 0;
    p.name = cleanName(rawName);
    if (look !== undefined) p.look = look;
    if (gear !== undefined) p.gear = gear;
    p.seq = -1;
    p.view = new ViewSet();
    p.rebuild = true;
    p.validator.reset(now);
    p.correctionUntil = 0;
    p.msgTokens = MSG_BURST;
    p.msgAt = now;
    this.byConn.set(conn.id, p);
    this.welcome(conn, p);
    this.jobs.resend(p.id);
  }

  message(conn: Conn, bytes: Uint8Array): void {
    this.counters.messagesIn += 1;
    let m: ClientMessage;
    try {
      m = decodeClient(bytes);
    } catch {
      const p = this.byConn.get(conn.id);
      if (!p || ++p.badMessages > MAX_BAD_MESSAGES) {
        this.reject(conn, ERROR_CODE.BAD_MESSAGE, 'Bad message');
      }
      return;
    }
    const p = this.byConn.get(conn.id);
    if (!p) {
      if (m.type === 'hello') this.admit(conn, m.version, m.name, m.token);
      else this.reject(conn, ERROR_CODE.BAD_MESSAGE, 'Say hello first');
      return;
    }
    if (!this.allow(p)) return;
    switch (m.type) {
      case 'state':
        this.state(p, m);
        break;
      case 'ping':
        this.ping(p, m.clientTime);
        break;
      case 'enter_vehicle':
        this.enterVehicle(p, m.vehicle);
        break;
      case 'exit_vehicle':
        this.exitVehicle(p);
        break;
      case 'shot':
        this.shot(p, m);
        break;
      case 'chat':
        this.chat(p, m.text);
        break;
      case 'emote':
        this.emote(p, m.emote);
        break;
      case 'job':
        // At a car park, "start" calls the player's own car; everywhere else it's a job.
        if (m.op === JOB_OP.START && this.city.points[m.point]?.kind === 'parking')
          void this.callCar(p, m.point);
        else {
          this.jobs.handle(this.jobPlayer(p), m.op, m.point);
          // A taxi shift comes with the company's cab.
          if (
            m.op === JOB_OP.START &&
            this.city.points[m.point]?.kind === 'taxi_depot' &&
            this.jobs.current(p.id)?.job === 'taxi'
          )
            this.spawnBeside(p, 'taxi', '🚕 Your cab is beside you. Fares are on the map.');
        }
        break;
      case 'call_car': {
        // At a car park, or (a car just bought) the dealership's desk.
        const kind = this.city.points[m.point]?.kind;
        if (kind === 'parking' || kind === 'dealer') void this.callCar(p, m.point, m.car);
        break;
      }
      case 'taxi':
        void this.taxi(p, m.x, m.z);
        break;
      case 'service':
        void this.service(p, m.point, m.what);
        break;
      case 'equip':
        this.equip(p, m.weapon);
        break;
      case 'reload':
        this.reload(p);
        break;
      case 'buy':
        void this.buyArms(p, m.point, m.item);
        break;
      case 'revive':
        this.revive(p, m.target);
        break;
      case 'act':
        this.act(p, m.what, m.arg);
        break;
      case 'hello':
        break;
    }
  }

  // ---- messages ------------------------------------------------------------------------

  /** Spends one message from the player's allowance; false (dropped) when it's used up. */
  private allow(p: Player): boolean {
    const now = this.now();
    p.msgTokens = Math.min(MSG_BURST, p.msgTokens + ((now - p.msgAt) / 1000) * MSG_RATE);
    p.msgAt = now;
    if (p.msgTokens >= 1) {
      p.msgTokens -= 1;
      return true;
    }
    p.dropped += 1;
    this.counters.dropped += 1;
    if (p.dropped > MAX_DROPPED) {
      this.counters.kicks += 1;
      this.reject(p.conn, ERROR_CODE.BAD_MESSAGE, 'Too many messages');
      this.close(p.conn);
    }
    return false;
  }

  /**
   * Checks the login token (when there is one, or when login is required), then welcomes the
   * player. One session per account: signing in again elsewhere ends the older session.
   */
  private admit(conn: Conn, version: number, name: string, token: string) {
    const pend = this.pending.get(conn.id);
    if (!pend || pend.authing) return;
    if (!token || !this.authenticate) {
      if (this.requireAuth)
        return this.reject(conn, ERROR_CODE.UNAUTHORIZED, 'Please log in to play');
      return this.hello(conn, version, name, null);
    }
    pend.authing = true;
    const verify = this.authenticate;
    void verify(token)
      .catch(() => null)
      .then((identity) => {
        // The socket closed (or timed out) while we were checking.
        if (!this.pending.has(conn.id)) return;
        if (!identity)
          return this.reject(
            conn,
            ERROR_CODE.UNAUTHORIZED,
            'Your login has expired. Please log in again.',
          );
        const account = identity.account;
        for (const other of this.players.values()) {
          if (other.account === account) {
            this.reject(other.conn, ERROR_CODE.UNAUTHORIZED, 'You signed in on another device');
            this.close(other.conn);
          }
        }
        // Where they were last, unless their body is still here to take up (a ghost).
        const ghost = [...this.players.values()].some((q) => q.account === account);
        void (ghost ? Promise.resolve(null) : this.lastPlace(account)).then((place) => {
          if (!this.pending.has(conn.id)) return;
          // A ticket's name and look are the character's; what the client typed is ignored.
          this.hello(
            conn,
            version,
            identity.name ?? name,
            account,
            identity.look,
            identity.gear,
            identity.staff,
            identity.xp,
            place,
          );
        });
      });
  }

  /** The place the API has for them; a slow API doesn't hold up logging in. */
  private async lastPlace(account: string): Promise<Place | null> {
    const api = this.staffApi;
    if (!api) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), PLACE_WAIT_MS);
    });
    try {
      const asked = api('place', { account }) as Promise<{ place?: Place | null }>;
      const r = await Promise.race([asked, late]);
      return r?.place ?? null;
    } catch (e) {
      console.error('place failed', e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `place` if a body can stand there now (the city may have changed), else null. */
  private usablePlace(place: Place | null | undefined): Place | null {
    if (!place) return null;
    const { x, z } = place;
    const room = interiorAt(x, z);
    if (room) {
      if (!this.collision.pointBlocked(x, z, PLACE_CLEAR_M, 0)) return { ...place, y: 0 };
      return { ...room.spawn, y: 0 };
    }
    const b = this.city.bounds;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || !isWalkable(x, z)) return null;
    const { ground, top } = this.heights(x, z);
    const y = Math.min(top, Math.max(ground, place.y));
    return this.collision.pointBlocked(x, z, PLACE_CLEAR_M, y) ? null : { ...place, y };
  }

  /** Where they come back. Down or in a bed: the Hospital's door, no quitting your way out. */
  private placeOf(p: Player): Place {
    if (p.downedUntil > 0 || p.bed >= 0) {
      const out = this.outside('hospital');
      if (out) return out;
    }
    const v = this.vehicles.get(p.vehicle);
    const { x, y, z, yaw } = v ? v.pose : p.pose;
    return { x, y, z, yaw };
  }

  /** Just outside a public building, facing the street. */
  private outside(service: ServiceId): Place | null {
    const door = this.city.points.find((q) => q.kind === 'entrance' && q.service === service);
    if (!door) return null;
    const x = door.x + Math.sin(door.yaw) * DOOR.stepOut;
    const z = door.z + Math.cos(door.yaw) * DOOR.stepOut;
    return { x, y: this.heights(x, z).top, z, yaw: door.yaw };
  }

  /** Saves where these players are, skipping those who haven't moved since the last save. */
  private savePlaces(list: Iterable<Player>): Promise<unknown> {
    const api = this.staffApi;
    if (!api) return Promise.resolve();
    const places = [];
    for (const p of list) {
      if (!p.account) continue;
      const place = this.placeOf(p);
      const key = `${Math.round(place.x)},${Math.round(place.z)}`;
      if (key === p.placeSaved) continue;
      p.placeSaved = key;
      places.push({ account: p.account, ...place });
    }
    if (places.length === 0) return Promise.resolve();
    return api('place/save', { places }).catch((e: unknown) =>
      console.error('saving places failed', e),
    );
  }

  /** Everyone's place, as the server stops. */
  saveAllPlaces(): Promise<unknown> {
    return this.savePlaces(this.players.values());
  }

  private hello(
    conn: Conn,
    version: number,
    rawName: string,
    account: string | null,
    look?: number,
    gear?: number,
    staff?: Staff,
    xp?: number,
    place?: Place | null,
  ) {
    this.pending.delete(conn.id);
    if (version !== PROTOCOL_VERSION) {
      return this.reject(conn, ERROR_CODE.BAD_VERSION, 'Please reload: the game has been updated');
    }
    if (account !== null) {
      // Banned while the ticket they hold was still good: the API refuses them new ones.
      if ((this.barred.get(account) ?? 0) > this.now())
        return this.reject(conn, ERROR_CODE.KICKED, 'This account is banned.');
      for (const g of this.players.values()) {
        if (g.account === account && g.ghostUntil > 0)
          return this.resume(conn, g, rawName, look, gear, staff, xp);
      }
    }
    if (this.players.size >= this.maxPlayers) {
      return this.reject(conn, ERROR_CODE.SERVER_FULL, 'Horizon is full. Try again shortly.');
    }
    const id = this.allocId();
    const spot = this.usablePlace(place) ?? { ...this.nextSpawn(), y: 0 };
    const now = this.now();
    const p: Player = {
      id,
      conn,
      account,
      name: cleanName(rawName),
      // Without a character (bots, local play): a varied look from the id.
      look: look ?? madeUpLook(id),
      // A character's gear from their ticket; made up only for players without a character.
      gear: gear ?? (look === undefined ? madeUpGear(id) : 0),
      pose: idle(spot.x, spot.y, spot.z, spot.yaw),
      seq: -1,
      vehicle: NO_ENTITY,
      hp: 100,
      view: new ViewSet(),
      rebuild: true,
      validator: new MoveValidator(this.collision, this.city.bounds, this.heights),
      correctionUntil: 0,
      strikes: 0,
      strikesAt: now,
      lastPingAt: 0,
      badMessages: 0,
      msgTokens: MSG_BURST,
      msgAt: now,
      dropped: 0,
      history: new PoseHistory(),
      lastShotAt: 0,
      chatTokens: CHAT_BURST,
      chatAt: now,
      emoteAt: 0,
      staff: staff ?? null,
      xp: xp ?? 0,
      chatMutedUntil: 0,
      carCalledAt: -Infinity,
      rideAt: -Infinity,
      hurtAt: -Infinity,
      arms: NO_ARMS,
      dutyRounds: 0,
      dutyPistol: false,
      membership: null,
      onDuty: false,
      dutyMs: 0,
      movedAt: now,
      shotsCalledAt: -Infinity,
      inHand: WEAPON.NONE,
      mag: {},
      reloadUntil: 0,
      spent: {},
      armed: false,
      helpAt: -Infinity,
      downedUntil: 0,
      bed: -1,
      bedFrom: 0,
      emsCalled: false,
      fallUntil: 0,
      ghostUntil: 0,
      seat: null,
      placeSaved: '',
    };
    p.validator.reset(now);
    this.players.set(id, p);
    this.byConn.set(conn.id, p);
    this.track(id, p.pose, true);
    this.welcome(conn, p);
    void this.jobs.joined(this.jobPlayer(p));
    void this.loadArms(p);
    void this.loadFaction(p);
  }

  private welcome(conn: Conn, p: Player) {
    const id = p.id;
    this.sendMsg(conn, {
      type: 'welcome',
      version: PROTOCOL_VERSION,
      you: id,
      serverTime: this.serverTime(),
      clock: this.clockAnchor(),
      spawn: p.pose,
    });
    if (this.voice) {
      this.voice(id, p.name).then(
        (pass) => {
          // Still the same session (the id may have been freed and reused meanwhile).
          if (this.byConn.get(conn.id) === p) this.sendMsg(conn, { type: 'voice', ...pass });
        },
        (e: unknown) => console.error('voice pass failed', e),
      );
    }
  }

  private state(p: Player, m: Pose & { seq: number }) {
    const delta = (m.seq - p.seq) & 0xffff;
    if (p.seq >= 0 && (delta === 0 || delta > 0x7fff)) return; // old or duplicate
    p.seq = m.seq;
    const now = this.now();
    if (p.downedUntil > 0 || p.fallUntil > 0 || p.seat) return;
    const vehicle = p.vehicle === NO_ENTITY ? null : this.vehicles.get(p.vehicle);
    const body = vehicle ? vehicle.pose : p.pose;

    if (now < p.correctionUntil) {
      // Reports sent before the client saw our correction: drop them quietly.
      if (Math.hypot(m.x - body.x, m.z - body.z) > CORRECTION_ACCEPT_RADIUS) return;
      p.correctionUntil = 0;
    }

    const limits = vehicle ? VEHICLE_LIMITS : FOOT_LIMITS;
    const verdict = p.validator.check(body, m, limits, now);
    if (verdict !== 'ok') return this.correct(p, body, now);

    const speed = Math.hypot(m.vx, m.vz);
    const scale = speed > limits.maxSpeed ? limits.maxSpeed / speed : 1;
    if (Math.hypot(m.x - body.x, m.z - body.z) > 0.05) p.movedAt = now;
    if (vehicle) this.wear(vehicle, Math.hypot(m.x - body.x, m.z - body.z), speed * scale, now);
    body.x = m.x;
    body.y = m.y;
    body.z = m.z;
    body.yaw = m.yaw;
    body.vx = m.vx * scale;
    body.vy = m.vy;
    body.vz = m.vz * scale;

    if (vehicle) {
      // Only presentation flags come from the driver; the vehicle has no posture, and its smoke
      // is the server's.
      body.state = (m.state & DRIVER_FLAGS) | this.carFlags(vehicle);
      this.moved(vehicle.id, body);
      p.pose.x = body.x;
      p.pose.y = body.y;
      p.pose.z = body.z;
      p.pose.yaw = body.yaw;
      p.pose.state = MODE.SEATED;
    } else {
      // SEATED and DOWNED are only ever set by the server.
      const mode = modeOf(m.state);
      const serverOnly = mode === MODE.SEATED || mode === MODE.DOWNED;
      body.state = serverOnly ? (m.state & 0xf0) | MODE.IDLE : m.state;
      // A weapon shows only if it's really in hand: the rifle's stance for the rifle.
      if (p.armed) {
        const held = p.inHand !== WEAPON.NONE;
        body.state &= ~(FLAG.ARMED | FLAG.RIFLE | (held ? 0 : FLAG.AIM));
        if (held) body.state |= FLAG.ARMED | (p.inHand === WEAPON.ASSAULT_RIFLE ? FLAG.RIFLE : 0);
      }
    }
    this.moved(p.id, p.pose);
  }

  /** Fuel burnt over `moved` metres, and condition lost if the car's speed fell like a crash. */
  private wear(v: Vehicle, moved: number, speed: number, now: number) {
    const dt = (now - v.lastAt) / 1000;
    if (v.lastAt > 0 && dt < 1)
      v.health = Math.max(0, v.health - crashDamage(v.lastSpeed, speed, dt));
    // A jump bigger than a report's worth is a correction or a respawn, not driving.
    if (moved < 40) v.fuel = Math.max(0, v.fuel - moved / FUEL.range);
    v.lastSpeed = speed;
    v.lastAt = now;
    this.tellCondition(v);
  }

  private correct(p: Player, body: Pose, now: number) {
    this.counters.corrections += 1;
    p.strikes = p.strikes * Math.exp(-(now - p.strikesAt) / STRIKE_DECAY_MS) + 1;
    p.strikesAt = now;
    if (p.strikes > STRIKE_KICK) {
      this.counters.kicks += 1;
      return this.reject(p.conn, ERROR_CODE.KICKED, 'Removed for invalid movement');
    }
    p.correctionUntil = now + CORRECTION_WINDOW_MS;
    p.validator.reset(now);
    this.sendMsg(p.conn, { type: 'correction', seq: p.seq & 0xffff, ...body });
  }

  private ping(p: Player, clientTime: number) {
    const now = this.now();
    if (now - p.lastPingAt < 400) return;
    p.lastPingAt = now;
    this.sendMsg(p.conn, { type: 'pong', clientTime, serverTime: this.serverTime() });
  }

  private enterVehicle(p: Player, vehicleId: number) {
    const v = this.vehicles.get(vehicleId);
    if (v?.owner && v.owner !== this.ownerKey(p)) {
      this.sendMsg(p.conn, {
        type: 'error',
        code: ERROR_CODE.SEAT_DENIED,
        message:
          v.owner === ON_SHOW
            ? 'This one is on show. Buy one at the sales desk.'
            : `That's ${v.ownerName ?? 'someone'}'s car`,
      });
      return;
    }
    const ok =
      v !== undefined &&
      v.driver === NO_ENTITY &&
      p.vehicle === NO_ENTITY &&
      modeOf(p.pose.state) !== MODE.DOWNED &&
      Math.hypot(p.pose.x - v.pose.x, p.pose.z - v.pose.z) <= VEHICLE_ENTER_RADIUS &&
      // Not up on the freeway deck from the street under it.
      Math.abs(p.pose.y - v.pose.y) <= 2.5;
    if (!v || !ok) {
      this.sendMsg(p.conn, {
        type: 'error',
        code: ERROR_CODE.SEAT_DENIED,
        message: 'You cannot get in that car',
      });
      if (v) this.sendMsg(p.conn, { type: 'seat', vehicle: v.id, driver: v.driver });
      return;
    }
    v.driver = p.id;
    p.vehicle = v.id;
    p.pose.state = MODE.SEATED;
    p.pose.x = v.pose.x;
    p.pose.z = v.pose.z;
    // Still seen, at the wheel (MODE.SEATED): others draw them in the driver's seat.
    this.moved(p.id, p.pose);
    p.validator.reset(this.now());
    this.broadcastSeat(v);
    v.lastAt = 0;
    v.heard.fuel = -1;
    this.tellCondition(v, true);
  }

  private exitVehicle(p: Player) {
    const v = this.vehicles.get(p.vehicle);
    if (!v) return;
    const speed = Math.hypot(v.pose.vx, v.pose.vz);
    this.releaseSeat(p);
    const spot = this.besideCar(v);
    Object.assign(p.pose, idle(spot.x, spot.y, spot.z, v.pose.yaw));
    this.moved(p.id, p.pose);
    p.rebuild = true;
    p.validator.reset(this.now());
    p.correctionUntil = this.now() + CORRECTION_WINDOW_MS;
    this.sendMsg(p.conn, { type: 'correction', seq: p.seq & 0xffff, ...p.pose });
    // Too fast to step out: down on the road, hurt by the speed, and up again in a moment.
    const hurt = fallDamage(speed);
    if (hurt > 0) {
      p.hp = Math.max(Math.min(p.hp, FALL.lowestHp), p.hp - hurt);
      p.fallUntil = this.now() + FALL.downMs + FALL.getUpMs;
      p.pose.state = MODE.DOWNED;
      this.moved(p.id, p.pose);
      this.sendMsg(p.conn, { type: 'health', hp: p.hp, downed: false });
    }
  }

  /** The driver's (left) door, or the other side if that is against a wall. */
  private besideCar(v: Vehicle) {
    const left = { x: Math.cos(v.pose.yaw), z: -Math.sin(v.pose.yaw) };
    let spot = { x: v.pose.x + left.x * 1.8, z: v.pose.z + left.z * 1.8 };
    if (this.collision.pointBlocked(spot.x, spot.z, 0.4, v.pose.y)) {
      spot = { x: v.pose.x - left.x * 1.8, z: v.pose.z - left.z * 1.8 };
    }
    // At the car's height: on a freeway deck or up a hill road, not on the street below.
    const ground = this.heights(spot.x, spot.z).ground;
    return { ...spot, y: Math.max(ground, v.pose.y) };
  }

  private releaseSeat(p: Player) {
    const v = this.vehicles.get(p.vehicle);
    p.vehicle = NO_ENTITY;
    this.evisible[p.id] = 1;
    if (!v) return;
    v.driver = NO_ENTITY;
    v.idleSince = this.now();
    v.pose.vx = 0;
    v.pose.vy = 0;
    v.pose.vz = 0;
    this.moved(v.id, v.pose);
    this.broadcastSeat(v);
  }

  private broadcastSeat(v: Vehicle) {
    const msg = encodeServer({ type: 'seat', vehicle: v.id, driver: v.driver }, this.writer);
    for (const viewer of this.players.values()) {
      const involved = viewer.id === v.driver || viewer.vehicle === v.id;
      if (involved || viewer.view.has(v.id)) this.send(viewer.conn, msg);
    }
  }

  // ---- entity mirrors ------------------------------------------------------------------

  private track(id: number, pose: Pose, visible: boolean) {
    this.poses[id] = pose;
    this.ex[id] = pose.x;
    this.ez[id] = pose.z;
    this.ever[id] = (this.ever[id] as number) + 1;
    this.evisible[id] = visible ? 1 : 0;
    this.grid.upsert(id, pose.x, pose.z);
  }

  private moved(id: number, pose: Pose) {
    this.ex[id] = pose.x;
    this.ez[id] = pose.z;
    this.ever[id] = (this.ever[id] as number) + 1;
    this.grid.upsert(id, pose.x, pose.z);
  }

  private untrack(id: number) {
    this.poses[id] = undefined;
    this.evisible[id] = 0;
    this.grid.remove(id);
  }

  // ---- combat ----------------------------------------------------------------------------

  private inSafeZone(x: number, z: number): boolean {
    if (interiorAt(x, z)?.safe) return true;
    return this.safeZones.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  }

  /**
   * A shot (technical-plan §9): validated against what the shooter could legally do, then
   * tested against every player near the line of fire as they were when the shooter saw them.
   */
  /**
   * Proximity text chat: a line to everyone within CHAT.RANGE (the speaker too, so they see
   * it as the others do). Tidied (no control characters, spaces squeezed, CHAT.MAX_CHARS at
   * most) and flood-limited: a burst of CHAT_BURST, then one every CHAT_EVERY_MS.
   */
  private chat(p: Player, raw: string) {
    const text = cleanChat(raw);
    if (!text) return;
    const now = this.now();
    if (text.startsWith('/')) {
      // A command (commands.ts), not chat; flood-limited the same way.
      p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (now - p.chatAt) / CHAT_EVERY_MS);
      p.chatAt = now;
      if (p.chatTokens < 1) return;
      p.chatTokens -= 1;
      const cmd = parse(text);
      if (FACTION_COMMANDS.has(cmd.name)) void this.factionCommand(p, cmd.name, cmd.args);
      else void runCommand(this.commandsFor(p), text);
      return;
    }
    if (p.chatMutedUntil > now) {
      const left = Math.ceil((p.chatMutedUntil - now) / 60000);
      return this.tell(p, `You're muted for ${left} more min.`);
    }
    p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (now - p.chatAt) / CHAT_EVERY_MS);
    p.chatAt = now;
    if (p.chatTokens < 1) return;
    p.chatTokens -= 1;
    const out = encodeServer({ type: 'chat', from: p.id, text }, this.writer);
    for (const id of this.grid.query(p.pose.x, p.pose.z, CHAT.RANGE, this.candidates)) {
      const other = this.players.get(id);
      if (!other) continue;
      const d = Math.hypot(other.pose.x - p.pose.x, other.pose.z - p.pose.z);
      if (d <= CHAT.RANGE) this.send(other.conn, out);
    }
  }

  /** Whose cars a player owns: their account, or (local play) their session. */
  private ownerKey(p: Player): string {
    return p.account ?? `anon:${p.id}`;
  }

  private ownCar(key: string): Vehicle | undefined {
    for (const v of this.vehicles.values()) if (v.owner === key) return v;
    return undefined;
  }

  /** A player's own car back to the garage: out of the world, its fuel and condition kept. */
  private garageCar(v: Vehicle) {
    this.dropVehicle(v);
    const api = this.staffApi;
    if (!api || v.carId === undefined || !v.owner || v.owner.startsWith('anon:')) return;
    api('garage/condition', {
      account: v.owner,
      car: v.carId,
      fuel: Math.max(0, Math.min(1, v.fuel)),
      health: Math.max(0, Math.min(1, v.health)),
    }).catch((e: unknown) => console.error('saving a car failed', e));
  }

  /** DAMAGED and WRECKED, from a car's condition. */
  private carFlags(v: Vehicle): number {
    if (v.health <= 0) return FLAG.WRECKED;
    return v.health < DAMAGE.smokeBelow ? FLAG.DAMAGED : 0;
  }

  /**
   * Tells a car's driver and owner its fuel and condition when either has changed enough to
   * show (at most twice a second, at once after a crash or a service), and updates its smoke.
   */
  private tellCondition(v: Vehicle, now = false) {
    const fuel = qUnit(v.fuel);
    const health = qUnit(v.health);
    const flags = this.carFlags(v);
    if ((v.pose.state & (FLAG.DAMAGED | FLAG.WRECKED)) !== flags) {
      v.pose.state = (v.pose.state & DRIVER_FLAGS) | flags;
      this.moved(v.id, v.pose);
    }
    const at = this.now();
    if (fuel === v.heard.fuel && health === v.heard.health) return;
    if (!now && health === v.heard.health && at - v.heard.at < 500) return;
    v.heard = { fuel, health, at };
    const msg = encodeServer(
      { type: 'car', vehicle: v.id, fuel: v.fuel, health: v.health },
      this.writer,
    );
    const driver = this.players.get(v.driver);
    if (driver) this.send(driver.conn, msg);
    if (v.owner)
      for (const q of this.players.values())
        if (q !== driver && this.ownerKey(q) === v.owner) this.send(q.conn, msg);
  }

  /**
   * At a car park's attendant (city `parking`): fuel or a repair for the player's own car, in
   * that lot, for what it lacks (shared car-condition), paid through the API.
   */
  private async service(p: Player, pointIndex: number, what: number) {
    const now = this.now();
    if (now - p.carCalledAt < 1500) return;
    p.carCalledAt = now;
    const point = this.city.points[pointIndex];
    if (point?.kind !== 'parking' || !canReach(point, p.pose.x, p.pose.z))
      return this.tell(p, 'Find the attendant at a car park’s P.');
    const v = this.ownCar(this.ownerKey(p));
    const lot = this.city.parking.find((l) => l.name === point.name);
    const near =
      v &&
      lot &&
      v.pose.x > lot.rect.x0 - 8 &&
      v.pose.x < lot.rect.x1 + 8 &&
      v.pose.z > lot.rect.z0 - 8 &&
      v.pose.z < lot.rect.z1 + 8;
    if (!v || !near) return this.tell(p, 'Bring your car into this car park first.');
    if (v.driver !== NO_ENTITY && v.driver !== p.id)
      return this.tell(p, 'Your car is being driven.');
    const fuel = what === SERVICE.FUEL;
    if (!fuel && what !== SERVICE.REPAIR) return;
    const cents = fuel ? fuelCost(v.fuel) : repairCost(v.health);
    if (cents === 0) return this.tell(p, fuel ? 'The tank is already full.' : 'Nothing to fix.');
    const api = this.staffApi;
    if (api && p.account) {
      try {
        await api('fare', {
          account: p.account,
          cents,
          kind: fuel ? 'fuel' : 'repair',
          key: `${fuel ? 'fuel' : 'repair'}-${Date.now()}-${p.id}`,
        });
      } catch (e) {
        return this.tell(p, e instanceof Error ? e.message : 'That didn’t go through.');
      }
    }
    if (!this.vehicles.has(v.id)) return;
    if (fuel) v.fuel = 1;
    else v.health = 1;
    this.tellCondition(v, true);
    const price = `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    this.tell(p, fuel ? `⛽ Tank full (${price}).` : `🔧 Repaired as new (${price}).`);
  }

  /** Street cars left empty or wrecked go back to their spawn, filled and fixed, in time. */
  private resetStreetCars(now: number) {
    // Rentals due back go, once nobody's in them.
    const wall = Date.now();
    for (const v of [...this.vehicles.values()]) {
      if (v.dueAt === undefined || v.dueAt > wall || v.driver !== NO_ENTITY) continue;
      this.garageCar(v);
      for (const q of this.players.values())
        if (this.ownerKey(q) === v.owner)
          this.tell(
            q,
            '🔑 Your rental is due back: it has gone to the Car Dealership. Buy your own there.',
          );
    }
    for (const v of this.vehicles.values()) {
      if (v.spawn === undefined || v.driver !== NO_ENTITY) continue;
      if ((v.fuel > 0.05 && v.health > 0) || now - v.idleSince < STREET_CAR_RESET_MS) continue;
      const s = this.city.vehicleSpawns[v.spawn];
      if (!s) continue;
      const taken = [...this.vehicles.values(), ...this.players.values()].some(
        (o) => o !== v && Math.hypot(o.pose.x - s.x, o.pose.z - s.z) < 3,
      );
      if (taken) continue;
      Object.assign(v, fresh());
      Object.assign(v.pose, idle(s.x, 0, s.z, s.yaw));
      this.moved(v.id, v.pose);
      this.tellCondition(v, true);
    }
  }

  /** Takes a vehicle out of the world. */
  private dropVehicle(v: Vehicle) {
    this.vehicles.delete(v.id);
    this.untrack(v.id);
    this.idPool.release(v.id);
  }

  /**
   * At a car park (city `parking`): one of the player's own cars (`carId` from the API's
   * garage, else their first; a starter car the first time) comes to a free bay of that lot.
   * At the dealership's desk (`dealer`), to one of its delivery bays (a car just bought).
   * One car out at a time: calling again, the one out goes back (unless someone is driving it).
   */
  private async callCar(p: Player, pointIndex: number, carId?: number) {
    const now = this.now();
    if (now - p.carCalledAt < 3000) return;
    p.carCalledAt = now;
    const point = this.city.points[pointIndex];
    if (!point || !canReach(point, p.pose.x, p.pose.z))
      return this.tell(p, 'Get closer to the car park.');
    const api = this.staffApi;
    if (!p.account && api) return this.tell(p, 'Log in to have a car of your own.');
    const key = this.ownerKey(p);
    const out = this.ownCar(key);
    if (out && out.driver !== NO_ENTITY) return this.tell(p, 'Your car is being driven.');
    let model = STARTER_CAR;
    let stored: { id: number; fuel: number; health: number } | undefined;
    let dueAt: number | undefined;
    if (api && p.account) {
      try {
        const g = (await api('garage', { account: p.account })) as {
          cars: {
            id: number;
            model: number;
            fuel?: number;
            health?: number;
            expiresAt?: string | null;
          }[];
        };
        const car = g.cars.find((c) => Number(c.id) === carId) ?? g.cars[0];
        if (!car)
          return this.tell(
            p,
            'Your garage is empty: your rental has gone back to the Car Dealership. Buy a car of your own there.',
          );
        dueAt = car.expiresAt ? Date.parse(car.expiresAt) : undefined;
        model = car?.model ?? STARTER_CAR;
        // (With damage off, a car saved damaged comes back like new.)
        if (car)
          stored = {
            id: Number(car.id),
            fuel: car.fuel ?? 1,
            health: DAMAGE.enabled ? (car.health ?? 1) : 1,
          };
      } catch (e) {
        console.error('garage failed', e);
        return this.tell(p, "Your garage can't be reached right now. Try again in a moment.");
      }
    }
    if (!this.players.has(p.id)) return;
    const lot =
      point.kind === 'dealer'
        ? this.city.dealership && {
            bays: this.city.dealership.delivery,
            entrance: point,
            rect: this.city.dealership.rect,
          }
        : this.city.parking.reduce<(typeof this.city.parking)[number] | undefined>(
            (best, l) =>
              !best ||
              Math.hypot(l.entrance.x - point.x, l.entrance.z - point.z) <
                Math.hypot(best.entrance.x - point.x, best.entrance.z - point.z)
                ? l
                : best,
            undefined,
          );
    if (!lot) return;
    if (out) this.garageCar(out);
    const free = lot.bays
      .map((b, i) => ({ b, i }))
      .filter(
        ({ b }) =>
          ![...this.vehicles.values()].some((v) => Math.hypot(v.pose.x - b.x, v.pose.z - b.z) < 3),
      )
      .sort(
        (a, b) =>
          Math.hypot(a.b.x - lot.entrance.x, a.b.z - lot.entrance.z) -
          Math.hypot(b.b.x - lot.entrance.x, b.b.z - lot.entrance.z),
      )[0];
    if (!free)
      return this.tell(
        p,
        point.kind === 'dealer'
          ? 'The delivery bays are full. Get it from any car park.'
          : 'This car park is full. Try another.',
      );
    const id = this.allocId();
    const v: Vehicle = {
      id,
      model,
      color: 0,
      pose: idle(free.b.x, lotHeight(this.city, lot.rect), free.b.z, free.b.yaw),
      driver: NO_ENTITY,
      owner: key,
      ownerName: p.name,
      carId: stored?.id,
      dueAt,
      ...fresh(stored?.fuel, stored?.health),
    };
    v.pose.state = this.carFlags(v);
    this.vehicles.set(id, v);
    this.track(id, v.pose, true);
    this.tellCondition(v, true);
    const name = CAR_MODELS[model]?.name ?? 'car';
    this.tell(
      p,
      point.kind === 'dealer'
        ? `🚗 Your ${name} is ready in delivery bay ${free.i + 1}, beside the showroom.`
        : `🚗 Your ${name} is waiting in bay ${free.i + 1}.`,
    );
  }

  /**
   * A taxi ride (the phone's Taxi app): to the sidewalk nearest (x, z), free while the player
   * is new (shared TAXI), else for a fare the API takes first. Not from a car, while downed,
   * during a job shift or straight after being hurt; one ride per cooldown.
   */
  private async taxi(p: Player, x: number, z: number) {
    const now = this.now();
    const no = (text: string) => this.sendMsg(p.conn, { type: 'ride', seconds: 0, cents: 0, text });
    if (!TAXI.enabled) return no('No cabs run in Los Soles yet.');
    if (now - p.rideAt < TAXI.cooldownMs)
      return no(
        `Your last cab just left. Try again in ${Math.ceil((TAXI.cooldownMs - (now - p.rideAt)) / 1000)} s.`,
      );
    if (p.vehicle !== NO_ENTITY) return no('Get out of the car first.');
    if (p.downedUntil > 0) return no('Nobody stops for you like this. Get back up first.');
    if (this.jobs.current(p.id))
      return no('Cabs don’t run during a shift. Finish or quit it first.');
    if (now - p.hurtAt < TAXI.afterHitMs)
      return no('No cab will stop here right now. Get somewhere safe.');
    if (!Number.isFinite(x) || !Number.isFinite(z)) return no('Where to?');
    const distance = rideDistance(p.pose.x, p.pose.z, x, z);
    if (distance < TAXI.minDistance) return no('That’s just round the corner. Walk it!');
    const drop = dropOff(this.city, this.collision, x, z);
    if (!drop) return no('No cab can get there. Pick a spot by a street.');
    p.rideAt = now;
    const cents = taxiFare(distance, p.xp);
    const api = this.staffApi;
    if (cents > 0 && api && p.account) {
      try {
        await api('fare', {
          account: p.account,
          cents,
          kind: 'taxi',
          key: `ride-${Date.now()}-${p.id}`,
          to: `${Math.round(drop.x)},${Math.round(drop.z)}`,
        });
      } catch (e) {
        p.rideAt = -Infinity;
        return no(e instanceof Error ? e.message : 'The fare didn’t go through.');
      }
    }
    // (Paid by now: even if they hopped into a car meanwhile, the cab takes them.)
    if (!this.players.has(p.id) || p.downedUntil > 0) return;
    const yaw = Math.atan2(drop.x - p.pose.x, drop.z - p.pose.z);
    this.sendMsg(p.conn, { type: 'ride', seconds: rideSeconds(distance), cents, text: '' });
    this.place(p, drop.x, drop.z, yaw);
  }

  // ---- the armoury (Phase 8; shared ARMORY) ---------------------------------------------

  /** What a logged-in player carries, from the API, when they join. */
  private async loadArms(p: Player) {
    const api = this.staffApi;
    if (!api || !p.account) return;
    p.armed = true;
    try {
      const r = (await api('arms', { account: p.account })) as { arms: Arms };
      if (!this.players.has(p.id)) return;
      this.setArms(p, r.arms);
    } catch (e) {
      console.error('arms failed', e);
    }
  }

  /** New arms from the API: magazines topped up for weapons new to them. */
  private setArms(p: Player, arms: Arms) {
    p.arms = { ...arms, rounds: { ...arms.rounds } };
    if (p.dutyPistol && !p.arms.weapons.includes(WEAPON.HEAVY_PISTOL))
      p.arms.weapons = [...p.arms.weapons, WEAPON.HEAVY_PISTOL].sort();
    else if (p.arms.weapons.includes(WEAPON.HEAVY_PISTOL)) p.dutyPistol = false;
    for (const w of arms.weapons) {
      const size = WEAPONS[w]?.magazine ?? 0;
      p.mag[w] = Math.min(p.mag[w] ?? size, size, this.roundsOf(p, w));
    }
    if (p.inHand !== WEAPON.NONE && !arms.weapons.includes(p.inHand)) p.inHand = WEAPON.NONE;
    this.sendArms(p);
  }

  private sendArms(p: Player) {
    const state = {
      ...p.arms,
      rounds: { ...p.arms.rounds, [WEAPON.HEAVY_PISTOL]: this.roundsOf(p, WEAPON.HEAVY_PISTOL) },
      inHand: p.inHand,
      mag: p.mag,
      // On duty (and as what), for the client's dispatch and revive.
      duty: p.onDuty && p.membership ? FACTIONS[p.membership.faction].kind : null,
      faction: p.membership?.faction ?? null,
      // Down or in a hospital bed: how long for, and which bed.
      downedMs: Math.max(0, p.downedUntil - this.now()),
      emsCalled: p.emsCalled,
      bed: p.bed >= 0 ? (INTERIORS.hospital.beds[p.bed] ?? null) : null,
      seat: p.seat,
      reloadMs: Math.max(0, p.reloadUntil - this.now()),
    };
    this.sendMsg(p.conn, { type: 'arms', state: JSON.stringify(state) });
  }

  /** A weapon they own into their hand (NONE puts it away); not in a car or downed. */
  private equip(p: Player, weapon: number) {
    if (!p.armed) return;
    if (weapon !== WEAPON.NONE && !p.arms.weapons.includes(weapon)) return this.sendArms(p);
    if (p.vehicle !== NO_ENTITY || p.downedUntil > 0) return;
    p.inHand = weapon;
    p.reloadUntil = 0;
    this.sendArms(p);
  }

  /** Fills the magazine in hand from their rounds, taking the weapon's reload time. */
  private reload(p: Player) {
    const w = p.inHand;
    const size = WEAPONS[w]?.magazine ?? 0;
    if (!p.armed || w === WEAPON.NONE || this.now() < p.reloadUntil) return;
    const full = Math.min(size, this.roundsOf(p, w));
    if ((p.mag[w] ?? 0) >= full) return this.sendArms(p);
    p.mag[w] = full;
    p.reloadUntil = this.now() + (ARMORY.reloadMs[w] ?? 2000);
    this.sendArms(p);
  }

  /**
   * Buys at the Gun Store (`gunstore`: the licence and the store's items) or the black market:
   * `item` 0 is the licence, then shared ARMORY.items in order.
   */
  private async buyArms(p: Player, pointIndex: number, item: number) {
    const now = this.now();
    if (now - p.carCalledAt < 1000) return;
    p.carCalledAt = now;
    const point = this.city.points[pointIndex];
    const where =
      point?.kind === 'gunstore' ? 'store' : point?.kind === 'black_market' ? 'black_market' : null;
    if (!point || !where || !canReach(point, p.pose.x, p.pose.z))
      return this.tell(p, 'Get closer to the counter.');
    const thing = item === 0 ? null : ARMORY.items[item - 1];
    if (item !== 0 && (!thing || thing.where !== where)) return this.tell(p, 'Not sold here.');
    if (item === 0 && where !== 'store') return this.tell(p, 'Licences are at the Gun Store.');
    const api = this.staffApi;
    if (!api || !p.account) return this.tell(p, 'Log in to buy.');
    try {
      const r = (await api('arms/buy', {
        account: p.account,
        item: thing?.id ?? 'licence',
        key: `arms-${Date.now()}-${p.id}`,
        xp: p.xp,
      })) as { arms: Arms; name: string; price: number };
      if (!this.players.has(p.id)) return;
      this.setArms(p, r.arms);
      this.tell(p, `🛒 ${r.name}: $${(r.price / 100).toLocaleString('en-US')}.`);
    } catch (e) {
      this.tell(p, e instanceof Error ? e.message : 'That didn’t go through.');
    }
  }

  /** Tells the API the rounds a player has fired since it last heard. */
  private flushRounds(p: Player) {
    const api = this.staffApi;
    if (!api || !p.account || Object.keys(p.spent).length === 0) return;
    const used = p.spent;
    p.spent = {};
    api('arms/rounds', { account: p.account, used }).catch((e: unknown) => {
      console.error('rounds failed', e);
      // Not lost: counted again next time.
      for (const [w, n] of Object.entries(used)) p.spent[Number(w)] = (p.spent[Number(w)] ?? 0) + n;
    });
  }

  // ---- factions (Phase 9; shared FACTIONS) ----------------------------------------------

  private async loadFaction(p: Player) {
    const api = this.staffApi;
    if (!api || !p.account) return;
    try {
      const r = (await api('faction', { account: p.account })) as {
        membership: Membership | null;
      };
      if (!this.players.has(p.id)) return;
      const was = p.membership;
      p.membership = r.membership;
      if (!r.membership || (was && was.faction !== r.membership.faction)) this.offDuty(p);
      // Name tags show the faction: everyone near sees them anew.
      this.reintroduce(p);
      this.sendArms(p);
    } catch (e) {
      console.error('faction failed', e);
    }
  }

  /** Rounds of weapon `w` a player has: their own, and a duty pistol's. */
  private roundsOf(p: Player, w: number): number {
    return (p.arms.rounds[w] ?? 0) + (w === WEAPON.HEAVY_PISTOL ? p.dutyRounds : 0);
  }

  private districtOf(p: Player): string {
    return districtName(districtAt(p.pose.x, p.pose.z));
  }

  /** An online player by name (exact, any case). */
  private online(name: string): Player | undefined {
    const want = name.trim().toLowerCase();
    for (const q of this.players.values()) if (q.name.toLowerCase() === want) return q;
    return undefined;
  }

  private onDutyIn(kind: 'police' | 'medical'): Player[] {
    return [...this.players.values()].filter(
      (q) => q.onDuty && q.membership && FACTIONS[q.membership.faction].kind === kind,
    );
  }

  /** Everyone who sees `p` gets them afresh: their faction or uniform has changed. */
  private reintroduce(p: Player) {
    const enter: ServerMessage = {
      type: 'enter',
      id: p.id,
      kind: ENTITY_KIND.PLAYER,
      model: 0,
      variant: 0,
      name: p.name,
      look: p.look,
      gear: p.gear,
      faction: this.factionTag(p),
      level: levelOf(p.xp).level,
    };
    for (const q of this.players.values()) {
      if (q.conn === NO_CONN) continue;
      for (let s = 0; s < q.view.count; s += 1) {
        if (q.view.ids[s] !== p.id) continue;
        this.sendMsg(q.conn, enter);
        // Their next snapshot goes out whatever has changed, or the new body has no place.
        q.view.version[s] = 0;
      }
    }
  }

  /** Their new XP total; a new level shows on their name tag at once. */
  private gainXp(p: Player, total: number) {
    const before = levelOf(p.xp).level;
    p.xp = Math.max(p.xp, total);
    if (levelOf(p.xp).level !== before) this.reintroduce(p);
  }

  /** The faction in `enter`, with the top bit for on duty. */
  private factionTag(p: Player): number {
    return factionCode(p.membership?.faction) | (p.onDuty ? ON_DUTY_BIT : 0);
  }

  /** Into or out of uniform (the lockers): on duty, paid while active. */
  private toggleDuty(p: Player) {
    const m = p.membership;
    const kind = m ? FACTIONS[m.faction].kind : null;
    if (!m || (kind !== 'police' && kind !== 'medical')) return;
    if (p.onDuty) {
      this.offDuty(p);
      return this.tell(p, 'Off duty.');
    }
    p.onDuty = true;
    p.dutyMs = 0;
    if (kind === 'police') {
      p.dutyRounds = 70;
      if (!p.arms.weapons.includes(WEAPON.HEAVY_PISTOL)) {
        p.dutyPistol = true;
        p.arms = { ...p.arms, weapons: [...p.arms.weapons, WEAPON.HEAVY_PISTOL].sort() };
      }
      p.mag[WEAPON.HEAVY_PISTOL] = Math.min(
        WEAPONS[WEAPON.HEAVY_PISTOL]?.magazine ?? 7,
        this.roundsOf(p, WEAPON.HEAVY_PISTOL),
      );
      this.sendArms(p);
    }
    this.sendArms(p);
    this.sendDispatch(kind === 'police' ? 'police' : 'medical');
    this.reintroduce(p);
    this.tell(
      p,
      `On duty as ${rankOf(m)?.title ?? ''}: paid for every ${SALARY.everyMs / 60_000} min active.${kind === 'police' ? ' Duty pistol issued (Q).' : ''}`,
    );
  }

  private offDuty(p: Player) {
    if (!p.onDuty) return;
    p.onDuty = false;
    this.reintroduce(p);
    p.dutyRounds = 0;
    if (p.dutyPistol) {
      p.dutyPistol = false;
      p.arms = { ...p.arms, weapons: p.arms.weapons.filter((w) => w !== WEAPON.HEAVY_PISTOL) };
      if (p.inHand === WEAPON.HEAVY_PISTOL) p.inHand = WEAPON.NONE;
    }
    this.sendArms(p);
    this.sendMsg(p.conn, { type: 'dispatch', state: '[]' });
  }

  /** Pay for every SALARY.everyMs of active time on duty (police and medics), from the salary faucet. */
  private payDuty(now: number) {
    const api = this.staffApi;
    for (const p of this.players.values()) {
      if (!p.onDuty || !p.membership || p.ghostUntil > 0) continue;
      if (now - p.movedAt < SALARY.idleMs) p.dutyMs += 1000;
      if (p.dutyMs < SALARY.everyMs) continue;
      p.dutyMs -= SALARY.everyMs;
      const rank = rankOf(p.membership);
      if (!rank || rank.salary <= 0 || !api || !p.account) continue;
      const reason = `${FACTIONS[p.membership.faction].short} pay · ${rank.title}`;
      api('reward', {
        account: p.account,
        source: 'faction',
        cents: rank.salary,
        xp: SALARY.xp,
        reason,
        key: `salary:${p.account}:${Math.floor(Date.now() / SALARY.everyMs)}:${p.id}`,
      })
        .then((r) => {
          const paid = r as { cents: number; xp: number; totalXp: number };
          this.gainXp(p, paid.totalXp);
          this.sendMsg(p.conn, { type: 'reward', ...paid, reason });
        })
        .catch((e: unknown) => console.error('salary failed', e));
    }
  }

  // Incidents: calls to the police and medics, and the city's own (someone down, shots fired).
  private readonly incidents = new Map<
    number,
    {
      id: number;
      kind: 'police' | 'medical';
      text: string;
      x: number;
      z: number;
      at: number;
      /** The player it's about (someone down), closed when they're up again. */
      subject: number | null;
      caller: number | null;
      responders: string[];
    }
  >();
  private nextIncident = 1;

  private incident(
    kind: 'police' | 'medical',
    text: string,
    x: number,
    z: number,
    subject: number | null,
    caller: number | null = null,
  ) {
    const id = this.nextIncident++;
    this.incidents.set(id, {
      id,
      kind,
      text,
      x,
      z,
      at: this.now(),
      subject,
      caller,
      responders: [],
    });
    for (const q of this.onDutyIn(kind)) this.tell(q, `🚨 ${text}. /respond ${id}`);
    this.sendDispatch(kind);
    return id;
  }

  private sendDispatch(kind: 'police' | 'medical') {
    const now = this.now();
    const list = [...this.incidents.values()]
      .filter((i) => i.kind === kind)
      .map((i) => ({
        id: i.id,
        text: i.text,
        x: Math.round(i.x),
        z: Math.round(i.z),
        minutes: Math.floor((now - i.at) / 60_000),
        responders: i.responders,
      }));
    const out = encodeServer({ type: 'dispatch', state: JSON.stringify(list) }, this.writer);
    for (const q of this.onDutyIn(kind)) this.send(q.conn, out);
  }

  private closeIncidentsOf(playerId: number) {
    for (const i of this.incidents.values())
      if (i.subject === playerId) {
        this.incidents.delete(i.id);
        this.sendDispatch(i.kind);
      }
  }

  private expireIncidents(now: number) {
    for (const i of this.incidents.values())
      if (now - i.at > 15 * 60_000) {
        this.incidents.delete(i.id);
        this.sendDispatch(i.kind);
      }
  }

  /** An on-duty medic beside someone down gets them back up (no hospital, no fee). */
  private revive(p: Player, targetId: number) {
    const t = this.players.get(targetId);
    const medic = p.onDuty && p.membership && FACTIONS[p.membership.faction].kind === 'medical';
    if (!medic) return this.tell(p, 'Only medics on duty can revive.');
    if (!t || t.downedUntil === 0 || t.bed >= 0 || p.downedUntil > 0) return;
    if (Math.hypot(t.pose.x - p.pose.x, t.pose.z - p.pose.z) > 3)
      return this.tell(p, 'Get closer.');
    t.hp = 60;
    t.downedUntil = 0;
    t.pose.state = MODE.IDLE;
    this.moved(t.id, t.pose);
    this.sendMsg(t.conn, { type: 'health', hp: t.hp, downed: false });
    this.closeIncidentsOf(t.id);
    this.tell(t, `🩺 ${p.name} got you back on your feet.`);
    this.tell(p, `🩺 You revived ${t.name}.`);
    const api = this.staffApi;
    if (api && p.account)
      api('reward', {
        account: p.account,
        source: 'faction',
        cents: 10_000,
        xp: 20,
        reason: `Revived ${t.name}`,
        key: `revive:${p.account}:${t.id}:${Math.floor(Date.now() / 1000)}`,
      })
        .then((r) => {
          const paid = r as { cents: number; xp: number; totalXp: number };
          this.gainXp(p, paid.totalXp);
          this.sendMsg(p.conn, { type: 'reward', ...paid, reason: `Revived ${t.name}` });
        })
        .catch((e: unknown) => console.error('revive pay failed', e));
  }

  /** The faction chat commands (FACTION_COMMANDS). */
  private async factionCommand(p: Player, cmd: string, args: string[]) {
    const api = this.staffApi;
    const m = p.membership;
    const kind = m ? FACTIONS[m.faction].kind : null;
    const say = (text: string) => this.tell(p, text);
    try {
      switch (cmd) {
        case '911':
        case 'ems': {
          const text = args.join(' ').slice(0, 100) || 'Needs help';
          const want = cmd === '911' ? 'police' : 'medical';
          const id = this.incident(want, `${p.name}: ${text}`, p.pose.x, p.pose.z, null, p.id);
          const n = this.onDutyIn(want).length;
          return say(
            n
              ? `📞 ${want === 'police' ? 'Police' : 'EMS'} told (call ${id}): ${n} on duty.`
              : `📞 Call ${id} logged. Nobody's on duty right now.`,
          );
        }
        case 'duty': {
          if (!m || kind === 'gang') return say('Duty is for the police and EMS.');
          const locker = this.city.points.find(
            (q) => q.kind === 'locker' && q.service === (kind === 'police' ? 'police' : 'hospital'),
          );
          if (locker && !canReach(locker, p.pose.x, p.pose.z))
            return say(
              `Change at the lockers in the ${kind === 'police' ? 'Police Station' : 'Hospital'}.`,
            );
          return this.toggleDuty(p);
        }
        case 'respond':
        case 'resolve': {
          const i = this.incidents.get(Number(args[0]));
          if (!i) return say('No such call.');
          if (!p.onDuty || !m || FACTIONS[m.faction].kind !== i.kind) return say('Not your call.');
          if (cmd === 'resolve') {
            this.incidents.delete(i.id);
            this.sendDispatch(i.kind);
            return say(`Call ${i.id} closed.`);
          }
          if (!i.responders.includes(p.name)) i.responders.push(p.name);
          const caller = i.caller === null ? undefined : this.players.get(i.caller);
          if (caller) this.tell(caller, `🚓 ${p.name} is on the way.`);
          this.sendDispatch(i.kind);
          return say(`Responding to call ${i.id}.`);
        }
        case 'f': {
          if (!m) return say('You’re not in a faction.');
          const text = args.join(' ').slice(0, 120);
          if (!text) return;
          for (const q of this.players.values())
            if (q.membership?.faction === m.faction)
              this.tell(q, `📻 [${FACTIONS[m.faction].short}] ${p.name}: ${text}`);
          return;
        }
        case 'vehicle': {
          if (!p.onDuty || (kind !== 'police' && kind !== 'medical'))
            return say('Service vehicles are for police and EMS on duty.');
          const place = kind === 'police' ? 'police' : 'hospital';
          const door = this.city.points.find((q) => q.kind === 'entrance' && q.service === place);
          if (door && Math.hypot(door.x - p.pose.x, door.z - p.pose.z) > VEHICLE_REACH_M)
            return say(`Service vehicles are outside the ${INTERIORS[place].name}.`);
          return this.serviceVehicle(p, kind);
        }
      }
      if (!api || !p.account) return say('That needs the city’s records, which aren’t reachable.');
      const name = args.join(' ');
      switch (cmd) {
        case 'accept':
        case 'reject': {
          const r = (await api('faction/decide', {
            actor: p.account,
            name,
            accept: cmd === 'accept',
          })) as {
            name: string;
            faction: string;
            accepted: boolean;
          };
          say(r.accepted ? `${r.name} is in.` : `${r.name} was turned down.`);
          const them = this.online(r.name);
          if (them) {
            this.tell(
              them,
              r.accepted && isFactionId(r.faction)
                ? `🎉 You're in: welcome to ${FACTIONS[r.faction].name}.`
                : 'Your application was turned down.',
            );
            void this.loadFaction(them);
          }
          return;
        }
        case 'interview': {
          // /interview "Name" 30: in that many minutes, at the faction's building.
          const r = (await api('faction/interview', {
            actor: p.account,
            name: args[0],
            minutes: Number(args[1]),
          })) as { name: string; faction: FactionId; at: string };
          say(`Interview set with ${r.name}.`);
          const them = this.online(r.name);
          if (them)
            this.tell(
              them,
              `📅 ${FACTIONS[r.faction].name} set your interview. See the Faction app.`,
            );
          return;
        }
        case 'promote':
        case 'demote': {
          const r = (await api('faction/rank', {
            actor: p.account,
            name,
            by: cmd === 'promote' ? 1 : -1,
          })) as {
            name: string;
            title: string;
          };
          say(`${r.name} is now ${r.title}.`);
          const them = this.online(r.name);
          if (them) {
            this.tell(them, `Your rank is now ${r.title}.`);
            void this.loadFaction(them);
          }
          return;
        }
        case 'dismiss': {
          const r = (await api('faction/dismiss', { actor: p.account, name })) as { name: string };
          say(`${r.name} dismissed.`);
          const them = this.online(r.name);
          if (them) {
            this.tell(them, 'You were dismissed from your faction.');
            void this.loadFaction(them);
          }
          return;
        }
        case 'boss': {
          if (p.staff?.role !== 'super') return say('Only the super admin appoints bosses.');
          const faction = args.at(-1);
          const r = (await api('faction/boss', {
            name: args.slice(0, -1).join(' '),
            faction,
            actor: p.name,
          })) as { name: string; faction: string; title: string };
          say(
            `${r.name} now leads ${isFactionId(r.faction) ? FACTIONS[r.faction].name : r.faction} as ${r.title}.`,
          );
          const them = this.online(r.name);
          if (them) {
            this.tell(
              them,
              `You now lead ${isFactionId(r.faction) ? FACTIONS[r.faction].name : r.faction}.`,
            );
            void this.loadFaction(them);
          }
          return;
        }
        case 'id': {
          if (!p.onDuty || kind !== 'police') return say('ID checks are for police on duty.');
          const them = this.online(name);
          if (!them || Math.hypot(them.pose.x - p.pose.x, them.pose.z - p.pose.z) > 5)
            return say('They need to be right in front of you.');
          const card = (await api('faction/id', { name: them.name })) as {
            name: string;
            age: number;
            licence: boolean;
            faction: string | null;
          };
          say(
            `🪪 ${card.name}, ${card.age}. Pistol licence: ${card.licence ? 'yes' : 'no'}.${card.faction ? ` ${card.faction}.` : ''}`,
          );
          this.tell(them, `🪪 ${p.name} checked your ID.`);
          return;
        }
        case 'fine': {
          if (!p.onDuty || kind !== 'police' || !hasPower(m, 'fine'))
            return say('Fines are for officers on duty.');
          const at = args.findIndex((a) => Number.isFinite(parseCents(a)));
          if (at < 1) return say('Usage: /fine "First Last" 250 reason');
          const them = this.online(args.slice(0, at).join(' '));
          if (!them || Math.hypot(them.pose.x - p.pose.x, them.pose.z - p.pose.z) > 10)
            return say('They need to be near you.');
          const r = (await api('faction/fine', {
            actor: p.account,
            name: them.name,
            cents: parseCents(args[at]),
            reason: args.slice(at + 1).join(' '),
            key: `fine-${Date.now()}-${p.id}`,
          })) as { name: string; cents: number };
          const amount = `$${(r.cents / 100).toLocaleString('en-US')}`;
          say(`Fined ${r.name} ${amount}.`);
          this.tell(them, `🚔 ${p.name} fined you ${amount}: ${args.slice(at + 1).join(' ')}`);
          return;
        }
      }
    } catch (e) {
      say(e instanceof Error ? e.message : 'That didn’t work.');
    }
  }

  /** A cruiser or an ambulance beside an officer or medic on duty (their own car goes back). */
  private serviceVehicle(p: Player, kind: 'police' | 'medical') {
    this.spawnBeside(
      p,
      kind === 'police' ? 'police' : 'ambulance',
      kind === 'police' ? '🚓 Your cruiser is beside you.' : '🚑 Your ambulance is beside you.',
    );
  }

  /** A work vehicle (CAR_MODELS id) beside the player, theirs while out (their own car goes back). */
  private spawnBeside(p: Player, modelId: string, said: string) {
    if (p.vehicle !== NO_ENTITY) return this.tell(p, 'Get out first.');
    const model = CAR_MODELS.findIndex((c) => c.id === modelId);
    const key = this.ownerKey(p);
    const out = this.ownCar(key);
    if (out && out.driver !== NO_ENTITY) return this.tell(p, 'Your car is being driven.');
    // Beside them, on whichever side is open.
    const side = { x: Math.cos(p.pose.yaw), z: -Math.sin(p.pose.yaw) };
    const spots = [3.5, -3.5].map((d) => ({ x: p.pose.x + side.x * d, z: p.pose.z + side.z * d }));
    const spot = spots.find((s) => !this.collision.pointBlocked(s.x, s.z, 1.4));
    if (!spot || model < 0) return this.tell(p, 'No room here: try an open street.');
    if (out) this.garageCar(out);
    const id = this.allocId();
    const v: Vehicle = {
      id,
      model,
      color: 0,
      pose: idle(spot.x, 0, spot.z, p.pose.yaw),
      driver: NO_ENTITY,
      owner: key,
      ownerName: p.name,
      ...fresh(),
    };
    this.vehicles.set(id, v);
    this.track(id, v.pose, true);
    this.tell(p, said);
  }

  /** A player as the jobs see them (jobs/jobs.ts). */
  private jobPlayer(p: Player): JobPlayer {
    return {
      id: p.id,
      account: p.account,
      x: p.pose.x,
      z: p.pose.z,
      onFoot: p.vehicle === NO_ENTITY,
      downed: p.downedUntil > 0,
      xp: p.xp,
      faction: p.membership?.faction ?? null,
    };
  }

  /** What the jobs need from the world: messages, and the API for pay and saved shifts. */
  private jobHost(): JobHost {
    const api = this.staffApi;
    const to = (id: number) => this.players.get(id);
    return {
      now: () => this.now(),
      serverTime: (at) => Math.round(at - this.startedAt),
      points: this.city.points,
      roads: RoadGraph.fromCity(this.city),
      send: (id, state) => {
        const p = to(id);
        if (p && p.conn !== NO_CONN) this.sendMsg(p.conn, { type: 'job', state });
      },
      rewarded: (id, r) => {
        const p = to(id);
        if (!p) return;
        this.gainXp(p, r.totalXp);
        if (p.conn !== NO_CONN)
          this.sendMsg(p.conn, {
            type: 'reward',
            cents: r.cents,
            xp: r.xp,
            totalXp: p.xp,
            reason: r.reason.slice(0, 120),
          });
      },
      tell: (id, text) => {
        const p = to(id);
        if (p) this.tell(p, text);
      },
      // Without the API (local play): the pay is shown but not kept.
      reward: async (account, pay) =>
        api
          ? ((await api('reward', { account, source: 'jobs', ...pay })) as {
              cents: number;
              xp: number;
              totalXp: number;
            })
          : { cents: pay.cents, xp: pay.xp, totalXp: 0 },
      settle: async (account) => {
        if (api) await api('haul/finish', { account });
      },
      save: async (account, saved) => {
        if (api) await api('jobs/save', { account, saved });
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      load: async (account) =>
        api ? ((await api('jobs/load', { account })) as { saved: Saved | null }).saved : null,
      anonymousOk: !api,
    };
  }

  /** A line from the server to one player (chat from NO_ENTITY). */
  private tell(p: Player, text: string) {
    this.sendMsg(p.conn, {
      type: 'chat',
      from: NO_ENTITY,
      text: fitBytes(text, CHAT.MAX_CHARS * 4),
    });
  }

  /** Puts a player at (x, z) on the ground (out of their car first), and tells their client. */
  private place(p: Player, x: number, z: number, yaw = p.pose.yaw) {
    if (p.vehicle !== NO_ENTITY) this.releaseSeat(p);
    const y = Math.max(0, this.heights(x, z).top);
    Object.assign(p.pose, idle(x, y, z, yaw));
    this.moved(p.id, p.pose);
    p.rebuild = true;
    p.validator.reset(this.now());
    p.correctionUntil = this.now() + CORRECTION_WINDOW_MS;
    this.sendMsg(p.conn, { type: 'correction', seq: p.seq & 0xffff, ...p.pose });
  }

  /** The nearest of `spots` to (x, z). */
  private nearest<T extends { x: number; z: number }>(
    spots: readonly T[],
    x: number,
    z: number,
  ): T | undefined {
    let best: T | undefined;
    let d = Infinity;
    for (const s of spots) {
      const e = Math.hypot(s.x - x, s.z - z);
      if (e < d) {
        d = e;
        best = s;
      }
    }
    return best;
  }

  /**
   * Removes a player at once (kicked, banned): no ghost, and their client won't reconnect.
   * Banned (`barMs`), their account can't come back on this server for that long either.
   */
  private kickPlayer(p: Player, reason: string, barMs = 0) {
    const conn = p.conn;
    // Out of the world first: closing may call close() straight away, which would ghost them.
    this.byConn.delete(conn.id);
    if (p.vehicle !== NO_ENTITY) this.releaseSeat(p);
    this.remove(p);
    if (barMs > 0 && p.account) this.barred.set(p.account, this.now() + barMs);
    if (conn !== NO_CONN)
      this.reject(
        conn,
        ERROR_CODE.KICKED,
        reason ? `Removed by an admin: ${reason}` : 'Removed by an admin',
      );
  }

  /** What a staff command can see and do (commands.ts), for player `p`. */
  private commandsFor(p: Player): CommandWorld {
    const byId = (id: number) => {
      const q = this.players.get(id);
      if (!q) throw new Error('That player has left.');
      return q;
    };
    const api = this.staffApi;
    return {
      me: { id: p.id, name: p.name, account: p.account, staff: p.staff },
      find: (name) => {
        const want = name.trim().toLowerCase();
        const online = [...this.players.values()].filter((q) => q.ghostUntil === 0);
        const exact = online.find((q) => q.name.toLowerCase() === want);
        if (exact) return { id: exact.id, name: exact.name };
        const starts = online.filter((q) => q.name.toLowerCase().startsWith(want));
        if (starts.length === 1 && starts[0]) return { id: starts[0].id, name: starts[0].name };
        return starts.length > 1 ? 'many' : 'none';
      },
      staffOnline: () =>
        [...this.players.values()].filter((q) => q.staff && q.ghostUntil === 0).map((q) => q.id),
      whereIs: (id) => {
        const q = this.players.get(id);
        return q
          ? { district: districtName(districtAt(q.pose.x, q.pose.z)), x: q.pose.x, z: q.pose.z }
          : null;
      },
      tell: (id, text) => {
        const q = this.players.get(id);
        if (q) this.tell(q, text);
      },
      announce: (text) => {
        for (const q of this.players.values()) this.tell(q, text);
      },
      moveTo: (id, x, z) => this.place(byId(id), x, z),
      moveNear: (id, toId) => {
        const to = byId(toId).pose;
        // Beside them, to their right.
        this.place(byId(id), to.x + Math.cos(to.yaw) * 1.6, to.z - Math.sin(to.yaw) * 1.6, to.yaw);
      },
      unstick: (id) => {
        const q = byId(id);
        const spot = this.nearest(this.city.playerSpawns, q.pose.x, q.pose.z);
        if (spot) this.place(q, spot.x, spot.z, spot.yaw);
      },
      unstickCar: (id) => {
        const q = byId(id);
        let car = q.vehicle !== NO_ENTITY ? this.vehicles.get(q.vehicle) : undefined;
        if (!car) {
          let d = 40;
          for (const v of this.vehicles.values()) {
            const e = Math.hypot(v.pose.x - q.pose.x, v.pose.z - q.pose.z);
            if (e < d) {
              d = e;
              car = v;
            }
          }
        }
        if (!car) return `No car near ${q.name}.`;
        // Whoever is driving it gets out first.
        const driver = car.driver === NO_ENTITY ? undefined : this.players.get(car.driver);
        if (driver) this.exitVehicle(driver);
        const free = this.city.vehicleSpawns.filter(
          (s) =>
            ![...this.vehicles.values()].some(
              (v) => v !== car && Math.hypot(v.pose.x - s.x, v.pose.z - s.z) < 4,
            ),
        );
        const spot = this.nearest(free, car.pose.x, car.pose.z);
        if (!spot) return 'No free parking spot nearby.';
        Object.assign(car.pose, idle(spot.x, 0, spot.z, spot.yaw));
        this.moved(car.id, car.pose);
        if (driver)
          this.place(driver, spot.x + Math.cos(spot.yaw) * 2.2, spot.z - Math.sin(spot.yaw) * 2.2);
        return `${q.name}'s car is back on the road.`;
      },
      kick: (id, reason, barMs) => {
        const q = this.players.get(id);
        if (q) this.kickPlayer(q, reason, barMs);
      },
      unbar: (account) => {
        this.barred.delete(account);
      },
      mute: (id, minutes) => {
        byId(id).chatMutedUntil = minutes > 0 ? this.now() + minutes * 60_000 : 0;
      },
      api: async (path, body) => {
        if (!api || !p.account) throw new Error("That isn't available on this server.");
        return api(path, { ...body, actor: p.account });
      },
      audit: (action, target, details = '') => {
        console.log(`staff ${p.name}: ${action} ${target} ${details}`.trim());
        if (api && p.account)
          void api('audit', { actor: p.account, action, target, details }).catch((e: unknown) =>
            console.error('audit failed', e),
          );
      },
      helpCooldown: () => (this.now() - p.helpAt) / 1000,
      markHelp: () => {
        p.helpAt = this.now();
      },
    };
  }

  /** An emote, to everyone who can see the player (not while down or in a car). */
  private emote(p: Player, emote: number) {
    if (!EMOTES[emote] || p.downedUntil > 0 || p.vehicle !== NO_ENTITY || p.seat) return;
    const now = this.now();
    if (now - p.emoteAt < 500) return;
    p.emoteAt = now;
    this.showEmote(p, emote);
  }

  /** Everyone near sees it; `self` for what the server decides (patching up), not the player. */
  private showEmote(p: Player, emote: number, self = false) {
    const out = encodeServer({ type: 'emote', from: p.id, emote }, this.writer);
    for (const id of this.grid.query(p.pose.x, p.pose.z, AOI.NEAR_RADIUS * 2, this.candidates)) {
      const other = this.players.get(id);
      if (other && (self || other !== p)) this.send(other.conn, out);
    }
  }

  private shot(
    p: Player,
    m: {
      weapon: number;
      viewTime: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
    },
  ) {
    const weapon = WEAPONS[m.weapon];
    const now = this.now();
    if (!weapon || p.downedUntil > 0 || p.vehicle !== NO_ENTITY) return;
    if (now - p.lastShotAt < weapon.intervalMs * 0.85) return;
    const muzzleOff = Math.hypot(m.x - p.pose.x, m.y - (p.pose.y + SHOOT_HEIGHT), m.z - p.pose.z);
    if (muzzleOff > MUZZLE_TOLERANCE) return;
    if (this.inSafeZone(p.pose.x, p.pose.z)) return;
    if (p.armed && m.weapon !== WEAPON.FIST) {
      // Only the weapon in hand, with a round in it, not mid-reload.
      const w = m.weapon;
      if (w !== p.inHand || now < p.reloadUntil || (p.mag[w] ?? 0) <= 0) return this.sendArms(p);
      p.mag[w] = (p.mag[w] ?? 0) - 1;
      // A duty pistol's rounds first: they aren't the officer's own.
      if (w === WEAPON.HEAVY_PISTOL && p.dutyRounds > 0) p.dutyRounds -= 1;
      else {
        p.arms.rounds[w] = Math.max(0, (p.arms.rounds[w] ?? 0) - 1);
        p.spent[w] = (p.spent[w] ?? 0) + 1;
      }
    }
    // Gunfire (not police on duty) calls the police, at most once a minute per shooter.
    if (m.weapon !== WEAPON.FIST && !(p.onDuty && p.membership?.faction === 'police')) {
      if (now - p.shotsCalledAt > 60_000) {
        p.shotsCalledAt = now;
        this.incident('police', `Shots fired in ${this.districtOf(p)}`, p.pose.x, p.pose.z, null);
      }
    }
    p.lastShotAt = now;

    const origin: Vec3 = { x: m.x, y: m.y, z: m.z };
    const dir = direction(m.yaw, m.pitch);
    // Rewind to what the shooter saw, but never further back than the cap.
    const serverTime = this.serverTime();
    const rewindTo = Math.max(serverTime - LAG_COMP_MAX_MS, Math.min(serverTime, m.viewTime));

    let best: { target: Player; t: number; zone: Zone } | null = null;
    const pos: Vec3 = { x: 0, y: 0, z: 0 };
    for (const id of this.grid.query(origin.x, origin.z, weapon.range, this.candidates)) {
      const target = this.players.get(id);
      if (!target || target === p || target.vehicle !== NO_ENTITY || target.downedUntil > 0)
        continue;
      if (!target.history.at(rewindTo, pos)) continue;
      const hit = hitCharacter(origin, dir, pos);
      if (!hit || hit.t > weapon.range || (best && hit.t >= best.t)) continue;
      best = { target, t: hit.t, zone: hit.zone };
    }
    // Buildings between the muzzle and the hit stop the bullet.
    if (best) {
      const hx = origin.x + dir.x * best.t;
      const hz = origin.z + dir.z * best.t;
      if (this.collision.segmentBlocked(origin.x, origin.z, hx, hz, 0)) best = null;
    }
    if (best && this.inSafeZone(best.target.pose.x, best.target.pose.z)) best = null;

    const fx = encodeServer(
      {
        type: 'shot_fx',
        shooter: p.id,
        weapon: m.weapon,
        x: origin.x,
        y: origin.y,
        z: origin.z,
        yaw: m.yaw,
        pitch: m.pitch,
        distance: best ? best.t : -1,
      },
      this.writer,
    );
    for (const id of this.grid.query(origin.x, origin.z, 150, this.candidates)) {
      const viewer = this.players.get(id);
      if (viewer && viewer !== p) this.send(viewer.conn, fx);
    }
    if (best) this.damage(best.target, p, best.zone, weapon[best.zone]);
  }

  private damage(target: Player, shooter: Player, zone: Zone, amount: number) {
    target.hp = Math.max(0, target.hp - amount);
    target.hurtAt = this.now();
    const zoneId =
      zone === 'head' ? HIT_ZONE.HEAD : zone === 'limb' ? HIT_ZONE.LIMB : HIT_ZONE.BODY;
    const hit = encodeServer(
      {
        type: 'hit',
        target: target.id,
        shooter: shooter.id,
        zone: zoneId,
        damage: amount,
        hp: target.hp,
      },
      this.writer,
    );
    // Everyone near sees the flinch (it used to be only the two of them).
    let shooterTold = false;
    for (const id of this.grid.query(target.pose.x, target.pose.z, 60, this.candidates)) {
      const q = this.players.get(id);
      if (!q) continue;
      this.send(q.conn, hit);
      if (q === shooter) shooterTold = true;
    }
    // A long shot: the shooter is further off than that.
    if (!shooterTold) this.send(shooter.conn, hit);
    if (target.hp === 0) {
      // The kill log, for staff looking into reports of random killing.
      this.staffApi?.('kills', {
        killer: shooter.account,
        victim: target.account,
        killerName: shooter.name,
        victimName: target.name,
        weapon: shooter.inHand === WEAPON.NONE ? WEAPON.FIST : shooter.inHand,
        x: target.pose.x,
        z: target.pose.z,
      }).catch((e: unknown) => console.error('kill log failed', e));
      target.seat = null;
      target.downedUntil = this.now() + DOWNED_SECONDS * 1000;
      target.pose.state = MODE.DOWNED;
      target.pose.vx = 0;
      target.pose.vz = 0;
      this.moved(target.id, target.pose);
    }
    this.sendMsg(target.conn, { type: 'health', hp: target.hp, downed: target.hp === 0 });
    if (target.hp === 0) this.sendArms(target);
  }

  /** Something a player does at a place (protocol ACT). */
  private act(p: Player, what: number, arg: number) {
    if (what === ACT.DOOR) this.useDoor(p, arg);
    else if (what === ACT.LOCKER) this.useLocker(p, arg);
    else if (what === ACT.BUY_CARE) void this.buyCare(p, arg);
    else if (what === ACT.USE_CARE) this.useCare(p, arg);
    else if (what === ACT.BUY_GOOD) void this.buyGood(p, arg);
    else if (what === ACT.FAINT) {
      if (p.downedUntil > 0 && p.bed < 0) this.respawn(p);
    } else if (what === ACT.CALL_EMS) this.callEms(p);
    else if (what === ACT.GET_UP) {
      if (p.bed >= 0) this.leaveBed(p);
    } else if (what === ACT.SIT) this.sit(p, arg);
    else if (what === ACT.STAND) this.stand(p);
  }

  /** Onto seat `index` of the room they're in, if it's free and they're beside it. */
  private sit(p: Player, index: number) {
    if (p.seat || p.vehicle !== NO_ENTITY || p.downedUntil > 0 || p.fallUntil > 0) return;
    const seat = interiorAt(p.pose.x, p.pose.z)?.seats[index];
    if (!seat || Math.hypot(seat.x - p.pose.x, seat.z - p.pose.z) > SEAT_REACH_M + 1) return;
    for (const q of this.players.values())
      if (q.seat === seat) return this.tell(p, 'Someone’s sitting there.');
    p.seat = seat;
    this.placeBody(p, seat.x, 0, seat.z, seat.yaw);
    p.pose.state = MODE.SITTING;
    this.moved(p.id, p.pose);
    this.sendArms(p);
  }

  /** Up from a seat, on the floor in front of it. */
  private stand(p: Player) {
    if (!p.seat) return;
    const spot = this.frontOf(p.seat);
    p.seat = null;
    this.placeBody(p, spot.x, 0, spot.z, spot.yaw);
    this.sendArms(p);
  }

  /** Where they end up standing: in front, or the first clear side (a desk's in the way). */
  private frontOf(seat: Seat) {
    for (const turn of SEAT_SIDES) {
      const yaw = seat.yaw + turn;
      const x = seat.x + Math.sin(yaw) * SEAT_STEP_M;
      const z = seat.z + Math.cos(yaw) * SEAT_STEP_M;
      if (!this.collision.pointBlocked(x, z, PLACE_CLEAR_M, 0)) return { x, y: 0, z, yaw };
    }
    return { x: seat.x, y: 0, z: seat.z, yaw: seat.yaw };
  }

  /** At their own lockers: on or off duty. */
  private useLocker(p: Player, point: number) {
    const locker = this.city.points[point];
    if (locker?.kind !== 'locker' || !canReach(locker, p.pose.x, p.pose.z)) return;
    const kind = p.membership ? FACTIONS[p.membership.faction].kind : null;
    if (kind !== (locker.service === 'police' ? 'police' : 'medical'))
      return this.tell(p, 'Staff only.');
    this.toggleDuty(p);
  }

  /** An EMS worker on duty, other than `p`, in the Hospital. */
  private hospitalStaff(p: Player): Player | null {
    for (const q of this.players.values()) {
      if (q === p || !q.onDuty || !q.membership) continue;
      if (FACTIONS[q.membership.faction].kind !== 'medical') continue;
      if (interiorAt(q.pose.x, q.pose.z)?.id === 'hospital') return q;
    }
    return null;
  }

  /** Buys a CARE item at the counter; an EMS worker in the building gets a share. */
  private async buyCare(p: Player, item: number) {
    const thing = CARE.items[item];
    const counter = this.city.points.find((q) => q.kind === 'counter');
    if (!thing || !counter || !canReach(counter, p.pose.x, p.pose.z))
      return this.tell(p, 'Get closer to the counter.');
    const now = this.now();
    if (now - p.carCalledAt < 1000) return;
    p.carCalledAt = now;
    const api = this.staffApi;
    if (!api || !p.account) return this.tell(p, 'Log in to buy.');
    const staff = this.hospitalStaff(p);
    try {
      const r = (await api('care/buy', {
        account: p.account,
        item: thing.id,
        staffed: staff !== null,
        key: `care-${Date.now()}-${p.id}`,
      })) as { arms: Arms; name: string; price: number };
      if (!this.players.has(p.id)) return;
      this.setArms(p, r.arms);
      this.tell(p, `🩹 ${r.name}: $${(r.price / 100).toLocaleString('en-US')}.`);
      if (!staff?.account) return;
      const reason = `Sold ${r.name.toLowerCase()} to ${p.name}`;
      const paid = (await api('reward', {
        account: staff.account,
        source: 'faction',
        cents: Math.round(r.price * CARE.commission),
        xp: 2,
        reason,
        key: `care-sale:${staff.account}:${now}:${p.id}`,
      })) as { cents: number; xp: number; totalXp: number };
      this.sendMsg(staff.conn, { type: 'reward', ...paid, reason });
    } catch (e) {
      this.tell(p, e instanceof Error ? e.message : 'That didn’t go through.');
    }
  }

  /** Buys a good for `$` at Sunny's till. USDC goods are paid from the player's wallet. */
  private async buyGood(p: Player, item: number) {
    const good = GOODS[item];
    const till = this.city.points.find((q) => q.kind === 'till');
    if (!good || !till || !canReach(till, p.pose.x, p.pose.z))
      return this.tell(p, 'Get closer to the till.');
    const now = this.now();
    if (now - p.carCalledAt < 1000) return;
    p.carCalledAt = now;
    const api = this.staffApi;
    if (!api || !p.account) return this.tell(p, 'Log in to buy.');
    try {
      const r = (await api('goods/buy', {
        account: p.account,
        good: good.id,
        key: `good-${Date.now()}-${p.id}`,
      })) as { arms: Arms; name: string; cents: number };
      if (!this.players.has(p.id)) return;
      this.setArms(p, r.arms);
      this.tell(p, `🛒 ${r.name}: $${(r.cents / 100).toLocaleString('en-US')}.`);
    } catch (e) {
      this.tell(p, e instanceof Error ? e.message : 'That didn’t go through.');
    }
  }

  /** Uses something from the bag: not while down, in a car, or just after being hit. */
  private useCare(p: Player, item: number) {
    const thing = CONSUMABLES[item];
    if (!thing || p.downedUntil > 0 || p.fallUntil > 0 || p.vehicle !== NO_ENTITY) return;
    const have = p.arms.care?.[thing.id] ?? 0;
    if (have <= 0 || p.hp >= MAX_HP) return;
    if (this.now() - p.hurtAt < CARE.noUseAfterHitMs)
      return this.tell(p, 'Not in the middle of a fight.');
    p.hp = Math.min(MAX_HP, p.hp + thing.heal);
    p.arms = { ...p.arms, care: { ...p.arms.care, [thing.id]: have - 1 } };
    this.sendMsg(p.conn, { type: 'health', hp: p.hp, downed: false });
    this.sendArms(p);
    this.showEmote(
      p,
      EMOTES.findIndex((e) => e.clip === thing.clip),
      true,
    );
    this.staffApi?.('care/use', { account: p.account, item: thing.id }).catch((e: unknown) =>
      console.error('care use failed', e),
    );
  }

  /** Down and calling for help: EMS hear, and they wait longer for them. */
  private callEms(p: Player) {
    if (p.downedUntil === 0 || p.bed >= 0 || p.emsCalled) return;
    p.emsCalled = true;
    p.downedUntil = this.now() + MEDICAL.emsWaitMs;
    this.incident('medical', `Person down in ${this.districtOf(p)}`, p.pose.x, p.pose.z, p.id);
    this.sendArms(p);
  }

  /** Through an entrance into its room, or back out to the street. */
  private useDoor(p: Player, point: number) {
    const door = this.city.points[point];
    if (!door?.service || p.vehicle !== NO_ENTITY || p.downedUntil > 0) return;
    if (!canReach(door, p.pose.x, p.pose.z)) return;
    const room = INTERIORS[door.service];
    if (door.kind === 'entrance') {
      if (room.members && p.membership?.faction !== room.id)
        return this.tell(p, `${room.name} is for members only.`);
      this.placeBody(p, room.spawn.x, 0, room.spawn.z, room.spawn.yaw);
    } else if (door.kind === 'exit') {
      const out = this.outside(door.service);
      if (out) this.placeBody(p, out.x, out.y, out.z, out.yaw);
    }
  }

  /** Moves a body somewhere walking couldn't take it, and tells its client. */
  private placeBody(p: Player, x: number, y: number, z: number, yaw: number) {
    Object.assign(p.pose, idle(x, y, z, yaw));
    this.moved(p.id, p.pose);
    p.rebuild = true;
    p.validator.reset(this.now());
    p.correctionUntil = this.now() + CORRECTION_WINDOW_MS;
    this.sendMsg(p.conn, { type: 'correction', seq: p.seq & 0xffff, ...p.pose });
  }

  /** Wakes in a hospital bed (no medic came, or they fainted), healing there. */
  private respawn(p: Player) {
    this.closeIncidentsOf(p.id);
    // At the hospital, for a fee (none taken from those who can't pay).
    const api = this.staffApi;
    if (api && p.account) {
      api('fare', {
        account: p.account,
        cents: HOSPITAL_FEE,
        kind: 'hospital',
        key: `hospital-${Date.now()}-${p.id}`,
      }).then(
        () => this.tell(p, `🏥 Patched up at the Hospital ($${HOSPITAL_FEE / 100}).`),
        () => this.tell(p, '🏥 Patched up at the Hospital. No charge this time.'),
      );
    }
    const beds = INTERIORS.hospital.beds;
    const taken = new Set([...this.players.values()].map((q) => q.bed));
    // A full ward: they share the last bed.
    const free = beds.findIndex((_, i) => !taken.has(i));
    const bed = free >= 0 ? free : beds.length - 1;
    const spot = beds[bed] as Bed;
    p.bed = bed;
    p.bedFrom = this.now();
    p.emsCalled = false;
    p.hp = MEDICAL.bedStartHp;
    p.downedUntil = this.now() + MEDICAL.bedMs;
    this.placeBody(p, spot.x, BED_Y, spot.z, spot.yaw);
    p.pose.state = MODE.DOWNED;
    this.moved(p.id, p.pose);
    this.sendMsg(p.conn, { type: 'health', hp: p.hp, downed: true });
    this.sendArms(p);
  }

  /** Up from a hospital bed, beside it, with the health they've got back. */
  private leaveBed(p: Player) {
    const room = INTERIORS.hospital;
    const spot = room.beds[p.bed] as Bed;
    p.bed = -1;
    p.downedUntil = 0;
    const mid = (room.rect.z0 + room.rect.z1) / 2;
    this.placeBody(p, spot.x, 0, spot.z + (spot.z > mid ? -BED_STEP_M : BED_STEP_M), 0);
    this.sendMsg(p.conn, { type: 'health', hp: p.hp, downed: false });
    this.sendArms(p);
  }

  /** A hospital bed's slow healing (each second). */
  private healInBed(p: Player, now: number) {
    const healed = Math.min(1, (now - p.bedFrom) / MEDICAL.bedMs);
    const hp = Math.round(MEDICAL.bedStartHp + (MAX_HP - MEDICAL.bedStartHp) * healed);
    if (hp === p.hp) return;
    p.hp = hp;
    this.sendMsg(p.conn, { type: 'health', hp, downed: true });
  }

  // ---- tick ----------------------------------------------------------------------------

  /** One simulation and snapshot step. Call tickHz times per second. */
  step(): void {
    const started = performance.now();
    this.tickNo += 1;
    this.counters.ticks += 1;
    const now = this.now();

    for (const pend of this.pending.values()) {
      if (now - pend.openedAt > HELLO_TIMEOUT_MS) {
        this.pending.delete(pend.conn.id);
        pend.conn.close(4000, 'hello timeout');
      }
    }

    const serverTime = this.serverTime();
    for (const p of this.players.values()) {
      if (p.ghostUntil > 0 && now >= p.ghostUntil) {
        this.remove(p);
        continue;
      }
      p.history.record(serverTime, p.pose.x, p.pose.y, p.pose.z);
      if (p.downedUntil > 0 && now >= p.downedUntil) {
        if (p.bed >= 0) {
          p.hp = MAX_HP;
          this.leaveBed(p);
        } else this.respawn(p);
      }
      if (p.bed >= 0 && this.tickNo % this.tickHz === 0) this.healInBed(p, now);
      if (p.fallUntil > 0 && now >= p.fallUntil) {
        p.fallUntil = 0;
        p.pose.state = MODE.IDLE;
        this.moved(p.id, p.pose);
      }
    }
    if (this.tickNo % this.tickHz === 0) {
      this.resetStreetCars(now);
      this.payDuty(now);
      this.expireIncidents(now);
    }
    // Rounds fired, to the API every half minute.
    if (this.tickNo % (this.tickHz * 30) === 0) {
      for (const q of this.players.values()) this.flushRounds(q);
      void this.savePlaces(this.players.values());
    }
    // Shifts that ran out, once a second.
    if (this.tickNo % this.tickHz === 0)
      this.jobs.tick(
        [...this.players.values()].filter((q) => q.ghostUntil === 0).map((q) => this.jobPlayer(q)),
      );
    for (const viewer of this.players.values()) {
      if (viewer.conn.buffered() > SLOW_CLIENT_BYTES) {
        this.counters.skippedSlow += 1;
        continue;
      }
      if (viewer.rebuild || (this.tickNo + viewer.id) % REBUILD_EVERY === 0) {
        viewer.rebuild = false;
        this.rebuildView(viewer, serverTime);
      } else {
        this.refreshView(viewer, serverTime);
      }
    }

    this.tickTimes.push(performance.now() - started);
    if (this.tickTimes.length > this.tickHz * 60) this.tickTimes.shift();
  }

  /**
   * Between rebuilds: walk the current view and send whatever its tier says is due. Entities
   * that vanished meanwhile are skipped here and dropped at the next rebuild.
   */
  private refreshView(p: Player, serverTime: number) {
    const view = p.view;
    const tick = this.tickNo;
    this.snapWriter.reset();
    const snap = this.snapshot.begin(serverTime);
    for (let s = 0; s < view.count; s += 1) {
      const id = view.ids[s] as number;
      if (this.evisible[id] === 0) continue;
      const version = this.ever[id] as number;
      const since = tick - (view.lastTick[s] as number);
      const due = since >= (view.every[s] as number) && view.version[s] !== version;
      if (!due && since < AOI.KEEPALIVE_TICKS) continue;
      const pose = this.poses[id];
      if (!pose) continue;
      view.lastTick[s] = tick;
      view.version[s] = version;
      snap.entity(id, pose);
    }
    if (snap.entities > 0) this.send(p.conn, snap.finish());
  }

  /**
   * Full view update: candidates, tier cut-offs, enter and leave, sent as one frame (leaves
   * and enters first, then the snapshot). Membership has rank hysteresis: a newcomer must be
   * among the nearest VIEW_MAX to enter, but a body already in view stays until it drops out
   * of the nearest VIEW_KEEP, so a milling crowd doesn't churn enter/leave messages.
   */
  private rebuildView(p: Player, serverTime: number) {
    const view = p.view;
    const { ex, ez, ever, evisible, ids, dist2, slotOf, slotGen, keep } = this;

    // Index the current view by entity id for O(1) membership during this pass.
    const gen = ++this.slotGenNo;
    for (let s = 0; s < view.count; s += 1) {
      const id = view.ids[s] as number;
      slotOf[id] = s;
      slotGen[id] = gen;
      keep[s] = 0;
    }

    const keepR = AOI.VIEW_RADIUS + VIEW_HYSTERESIS;
    const keepR2 = keepR * keepR;
    const viewR2 = AOI.VIEW_RADIUS * AOI.VIEW_RADIUS;
    const px = p.pose.x;
    const pz = p.pose.z;
    let n = 0;
    for (const id of this.grid.query(px, pz, keepR, this.candidates)) {
      if (id === p.id || evisible[id] === 0 || id === p.vehicle) continue;
      const dx = (ex[id] as number) - px;
      const dz = (ez[id] as number) - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > keepR2 || (d2 > viewR2 && slotGen[id] !== gen)) continue;
      ids[n] = id;
      dist2[n] = d2;
      n += 1;
    }

    // Cut-offs cascade on shrinking prefixes: keep (160), enter (128), mid (64), near (16).
    let keepCut = Infinity;
    let enterCut = Infinity;
    let midCut = AOI.MID_RADIUS ** 2;
    let nearCut = AOI.NEAR_RADIUS ** 2;
    if (n > AOI.NEAR_MAX) {
      const scratch = this.scratch;
      scratch.set(dist2.subarray(0, n));
      let m = n;
      if (m > AOI.VIEW_KEEP) {
        keepCut = selectInPlace(scratch, m, AOI.VIEW_KEEP - 1);
        m = AOI.VIEW_KEEP;
      }
      if (m > AOI.VIEW_MAX) {
        enterCut = selectInPlace(scratch, m, AOI.VIEW_MAX - 1);
        m = AOI.VIEW_MAX;
      }
      if (m > AOI.MID_MAX) {
        midCut = Math.min(midCut, selectInPlace(scratch, m, AOI.MID_MAX - 1));
        m = AOI.MID_MAX;
      }
      if (m > AOI.NEAR_MAX) {
        nearCut = Math.min(nearCut, selectInPlace(scratch, m, AOI.NEAR_MAX - 1));
      }
    }
    // Newcomers exactly at the enter cut-off share the remaining places, so the cap is strict.
    let tiePlaces = AOI.VIEW_MAX;
    if (enterCut !== Infinity) {
      for (let i = 0; i < n; i += 1) if ((dist2[i] as number) < enterCut) tiePlaces -= 1;
    }

    const tick = this.tickNo;
    const pre = this.pre.reset();
    this.snapWriter.reset();
    const snap = this.snapshot.begin(serverTime);
    let added = 0;
    for (let i = 0; i < n; i += 1) {
      const d2 = dist2[i] as number;
      if (d2 > keepCut) continue;
      const id = ids[i] as number;
      const slot = slotGen[id] === gen ? (slotOf[id] as number) : -1;
      if (slot < 0 && (d2 > enterCut || (d2 === enterCut && tiePlaces-- <= 0))) continue;
      const version = ever[id] as number;
      const every = d2 <= nearCut ? AOI.NEAR_EVERY : d2 <= midCut ? AOI.MID_EVERY : AOI.FAR_EVERY;
      if (slot >= 0) {
        keep[slot] = 1;
        view.every[slot] = every;
        const since = tick - (view.lastTick[slot] as number);
        const due = since >= every && view.version[slot] !== version;
        if (!due && since < AOI.KEEPALIVE_TICKS) continue;
        view.lastTick[slot] = tick;
        view.version[slot] = version;
      } else {
        if (added >= this.newIds.length) continue;
        this.announce(id, pre);
        this.newIds[added] = id;
        this.newVersions[added] = version;
        this.newEvery[added] = every;
        added += 1;
      }
      const pose = this.poses[id];
      if (pose) snap.entity(id, pose);
    }

    // Drop what left the view, keep the rest, append the newcomers.
    let w = 0;
    for (let s = 0; s < view.count; s += 1) {
      const id = view.ids[s] as number;
      if (keep[s] === 0) {
        writeServer({ type: 'leave', id }, pre);
        continue;
      }
      view.ids[w] = id;
      view.lastTick[w] = view.lastTick[s] as number;
      view.version[w] = view.version[s] as number;
      view.every[w] = view.every[s] as number;
      w += 1;
    }
    for (let j = 0; j < added && w < ViewSet.CAP; j += 1) {
      view.ids[w] = this.newIds[j] as number;
      view.lastTick[w] = tick;
      view.version[w] = this.newVersions[j] as number;
      view.every[w] = this.newEvery[j] as number;
      w += 1;
    }
    view.count = w;

    if (pre.length === 0) {
      if (snap.entities > 0) this.send(p.conn, snap.finish());
      return;
    }
    const frame = this.frame.reset().bytes(pre.peek());
    if (snap.entities > 0) frame.bytes(snap.finish());
    this.send(p.conn, frame.peek());
  }

  /** Introduces an entity that just came into a player's view (appended to `out`). */
  private announce(id: number, out: Writer) {
    const other = this.players.get(id);
    if (other) {
      const kind = ENTITY_KIND.PLAYER;
      writeServer(
        {
          type: 'enter',
          id,
          kind,
          model: 0,
          variant: 0,
          name: other.name,
          look: other.look,
          gear: other.gear,
          faction: this.factionTag(other),
          level: levelOf(other.xp).level,
        },
        out,
      );
      return;
    }
    const v = this.vehicles.get(id);
    if (!v) return;
    const kind = ENTITY_KIND.VEHICLE;
    writeServer(
      {
        type: 'enter',
        id,
        kind,
        model: v.model,
        variant: v.color,
        // A player's own car carries its owner's name (the client only offers it to them);
        // the dealership's carry a label, so nobody is offered them.
        name: v.owner === ON_SHOW ? 'For sale' : v.ownerName ? `${v.ownerName}'s car` : '',
        look: 0,
        gear: 0,
      },
      out,
    );
    if (v.driver !== NO_ENTITY) writeServer({ type: 'seat', vehicle: v.id, driver: v.driver }, out);
  }

  // ---- helpers -------------------------------------------------------------------------

  private allocId(): number {
    return this.idPool.take();
  }

  /** Round-robin over the spawn points, spread on a small spiral so arrivals don't stack. */
  private nextSpawn() {
    const spawns = this.city.playerSpawns;
    const n = this.spawnCursor++;
    const spot = spawns[n % spawns.length];
    if (!spot) throw new Error('city has no player spawns');
    const ring = Math.floor(n / spawns.length) % 16;
    const angle = ring * 2.39996;
    const r = ring === 0 ? 0 : 1 + Math.sqrt(ring) * 1.2;
    const x = spot.x + Math.cos(angle) * r;
    const z = spot.z + Math.sin(angle) * r;
    return this.collision.pointBlocked(x, z, 0.5) ? spot : { x, z, yaw: spot.yaw };
  }

  private reject(conn: Conn, code: number, message: string) {
    this.sendMsg(conn, { type: 'error', code, message: fitBytes(message, 256) });
    // Close reasons are at most 123 bytes.
    conn.close(4000 + code, fitBytes(message, 120));
  }

  private sendMsg(conn: Conn, m: ServerMessage) {
    this.send(conn, encodeServer(m, this.writer));
  }

  private send(conn: Conn, bytes: Uint8Array) {
    this.counters.bytesOut += bytes.byteLength;
    this.counters.framesOut += 1;
    conn.send(bytes);
  }

  /** Counters since the last call, plus tick-time percentiles over the last minute. */
  stats(): WorldStats {
    const sorted = [...this.tickTimes].sort((a, b) => a - b);
    const pct = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const c = this.counters;
    this.counters = freshCounters();
    return {
      players: this.players.size,
      ticks: c.ticks,
      tickMsP50: pct(0.5),
      tickMsP95: pct(0.95),
      tickMsP99: pct(0.99),
      tickMsMax: sorted[sorted.length - 1] ?? 0,
      bytesOut: c.bytesOut,
      framesOut: c.framesOut,
      messagesIn: c.messagesIn,
      corrections: c.corrections,
      skippedSlow: c.skippedSlow,
      kicks: c.kicks,
      dropped: c.dropped,
    };
  }
}

function cleanName(raw: string): string {
  const printable = [...raw].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
  const name = printable.join('').trim().slice(0, 24);
  return name.length > 0 ? name : 'Guest';
}
