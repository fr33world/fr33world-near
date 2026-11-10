/**
 * The game runtime: renderer, scene, frame loop and the systems that hang off it. React only
 * reads `stats` and `hud` from here at a throttled rate; nothing per-frame goes through React.
 *
 * URL parameters for testing and screenshots:
 *   ?q=low|medium|high      quality tier
 *   ?t=17.5                 fixed hour of day (stops the clock)
 *   ?fly                    free orbit camera instead of playing
 *   ?cam=x,y,z,tx,ty,tz     fly-camera position and target
 *   ?server=ws://host:7400/ws  world server (default: VITE_WORLD_URL, else this host:7400)
 *   ?offline                play without connecting
 *   ?name=Ada               player name
 */
import {
  type CityLayout,
  generateCity,
  heightRange,
  type VehicleSpawn,
  WORLD,
  type Bed,
  BED_TURN,
  BED_Y,
  DOOR,
  interiorAt,
  INTERIORS,
  type Seat,
  SEAT_REACH_M,
  SEAT_Y,
  type RoomId,
  type ServiceId,
} from '@fr33world/city';
import {
  ACT,
  EMOTES,
  ENTITY_KIND,
  ERROR_CODE,
  FLAG,
  JOB_OP,
  MODE,
  modeOf,
  NO_ENTITY,
  type Pose,
  type ServerMessage,
  WEAPON,
} from '@fr33world/protocol';
import {
  CLIENT_SEND_HZ,
  CLOCK_EPOCH,
  type ClockAnchor,
  DEALER_MODELS,
  decodeAppearance,
  type FactionId,
  isFactionId,
  uniformOf,
  uniformOutfit,
  factionOfBuilding,
  enginePower,
  decodeGear,
  DEFAULT_APPEARANCE,
  encodeAppearance,
  formatClock,
  gameMinutesAt,
  hourOfDay,
  isTutorialStep,
  JOB_OFFERS,
  type JobView,
  levelOf,
  FALL,
  VEHICLE_ENTER_RADIUS,
} from '@fr33world/shared';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FollowCamera } from './camera.ts';
import { Character, FOOT_LIFT, type Look } from './character/character.ts';
import { initTextures } from './assets.ts';
import { InteriorsView } from './city/interiors.ts';
import { Combat } from './combat.ts';
import { buildCity, type CityView, SLAB_Y } from './city/city.ts';
import { MARKER_RADIUS, parkingMarker } from './city/parking.ts';
import { Input } from './input.ts';
import { NetClient, ServerRefused } from './net.ts';
import { Textures, worldUniforms } from './materials.ts';
import { PHYSICS_DT, Physics } from './physics.ts';
import { LocalPlayer } from './player.ts';
import { detectQuality, isTouchDevice, type Quality, ResolutionGovernor } from './quality.ts';
import { careShaders } from './character/patchup.ts';
import { RemoteWorld } from './remote.ts';
import { wakeServer, worldUrl } from './server.ts';
import { Voice, type VoiceState } from './voice.ts';
import { DayNight } from './sky.ts';
import { VehicleManager } from './vehicles/manager.ts';
import { type SeatCar, seatCharacter } from './vehicles/seating.ts';
import { GameSounds } from './sounds.ts';
import { SHOW_ALL_TILES } from './city/tiles.ts';
import {
  applyFaction,
  claimDaily,
  fetchConversations,
  fetchThread,
  sendDirectMessage,
  type DailyPaid,
  type DailyStatus,
  fetchDaily,
  fetchDesk,
  fetchGangs,
  type FactionDesk,
  gangAction,
  type GangStatus,
  buyCar,
  type FactionStatus,
  fetchBlocks,
  fetchFactions,
  fetchInbox,
  fetchListings,
  type Listing,
  marketCall,
  leaveFaction,
  takeFactionQuiz,
  type GarageCar,
  fetchGarage,
  fetchProgress,
  fetchStatement,
  type Progress,
  saveTutorial,
  sendPayment,
  sendReport,
  setBlock,
  type Statement,
} from './api.ts';
import { waiting } from '../hud/Rewards.tsx';
import { type Interaction, type InteractionIcon, Interactions } from './interactions.ts';
import { Tutorial } from './tutorial.ts';
import { Waypoints } from './waypoint.ts';

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  heapMB: number;
  tier: string;
  /** Rendering resolution, % of the tier's (Auto lowers it to hold the frame rate). */
  resolution: number;
}

export interface GameSession {
  /** World ticket; '' without a login (dev, offline). */
  token: string;
  name: string;
  /** `$` balance in cents from the API, or null when unknown. */
  balance?: number | null;
  /** A fresh token for reconnecting (tickets expire after a few minutes). */
  renew?: () => Promise<string>;
  /** The character's appearance (shared `encodeAppearance`); the default without one. */
  look?: number;
  /** What they wear besides the outfit (shared `encodeGear`); nothing without it. */
  gear?: number;
  /** The character's experience (shared `levelOf`). */
  xp?: number;
  /** Where the tutorial is (shared TUTORIAL_STEPS; 'done' or 'skipped' when over). */
  tutorial?: string;
  /** A fresh login token for the API (blocks, reports); absent when playing without one. */
  apiToken?: () => Promise<string>;
  /** Signs a hash with the player's own NEAR wallet (absent for guests and offline). */
  signHash?: (hash: `0x${string}`) => Promise<string>;
}

/** A line of proximity chat as the HUD shows it. */
export interface ChatLine {
  key: number;
  from: number;
  name: string;
  text: string;
  /** Said by this player. */
  you: boolean;
  /** From the server (command replies, admin calls, announcements), not a player. */
  system?: boolean;
  at: number;
}
/** Lines kept in the feed, and how long a speech bubble stays (ms). */
const CHAT_KEEP = 40;
const BUBBLE_MS = 6000;

export interface HudState {
  clock: string;
  hour: number;
  /** The prompt now (interactions.ts): what it does ("Enter car"), its icon, and how far
   * through a hold (0–1) when it must be held. */
  action: string | null;
  actionIcon: InteractionIcon | null;
  actionHeld: number;
  /** "online", "connecting", "offline" plus a reason. */
  net: string;
  ping: number;
  nearby: number;
  driving: boolean;
  /** Riding beside someone else's driving. */
  passenger: boolean;
  /** Speedometer, km/h. */
  speedKmh: number;
  /** Drive, reverse, or standing in neutral. */
  gear: 'D' | 'R' | 'N';
  /** The driven car's fuel and condition, 0–1 (the server's). */
  fuel: number;
  carHealth: number;
  armed: boolean;
  aiming: boolean;
  /** The weapon in hand's magazine and rounds in all, and whether it's reloading. */
  ammo: { mag: number; total: number; reloading: boolean } | null;
  /** Called EMS while down. */
  emsCalled: boolean;
  /** Healing in a hospital bed. */
  inBed: boolean;
  /** The room we're in (its name), else null. */
  indoors: string | null;
  /** Fading through a door. */
  fading: boolean;
  /** The crosshair is on a person, with nothing in the way. */
  aimOnPerson: boolean;
  /** Owns a weapon (the touch weapon button shows). */
  ownsWeapon: boolean;
  /** Unread notices in the inbox (the phone's badge). */
  unread: number;
  /** Daily rewards waiting to be claimed. */
  dailyReady: number;
  /** Private messages unread. */
  unreadMessages: number;
  /** `$` balance in cents, or null when unknown (no login, API unreachable). */
  money: number | null;
  /** Experience, or null without a character (shared `levelOf` makes the level). */
  xp: number | null;
  /** Proximity voice: connection state, holding the mic open, voices in earshot. */
  voice: VoiceState;
  talking: boolean;
  hearing: number;
  hp: number;
  downed: boolean;
  /** performance.now() of our last confirmed hit / of the last damage we took. */
  hitAt: number;
  hitHead: boolean;
  hurtAt: number;
  /** Seconds until respawn while downed. */
  respawnIn: number;
}

const AIM_DIR = new THREE.Vector3();

/** A player's chest above their feet (aim assist's mark). */
const CHEST = new THREE.Vector3(0, 1.2, 0);
const BED_POS = new THREE.Vector3();
const SEAT_POS = new THREE.Vector3();
/** The fade through a door (ms), and the sky's hour indoors. */
const DOOR_FADE_MS = 500;
const INDOOR_HOUR = 13;
/** How long after entering the city the frame rate starts to count (ms). */
const ENTRY_SETTLE_MS = 8000;
/** Our open 911 call, as the world server tells it. */
export interface EmergencyCall {
  id: number;
  kind: 'police' | 'medical';
  onDuty: number;
  responders: string[];
}

/** How long the aim stays up after the last shot (ms). */
const AIM_HOLD_MS = 1_200;

export class Game {
  readonly quality: Quality;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly stats: FrameStats;
  readonly hud: HudState = {
    clock: '--:--',
    hour: 12,
    action: null,
    actionIcon: null,
    actionHeld: 0,
    net: 'connecting',
    ping: 0,
    nearby: 0,
    driving: false,
    passenger: false,
    speedKmh: 0,
    gear: 'N',
    fuel: 1,
    carHealth: 1,
    armed: false,
    ammo: null,
    emsCalled: false,
    inBed: false,
    indoors: null,
    fading: false,
    aimOnPerson: false,
    ownsWeapon: false,
    unread: 0,
    dailyReady: 0,
    unreadMessages: 0,
    aiming: false,
    money: null,
    xp: null,
    voice: 'off',
    talking: false,
    hearing: 0,
    hp: 100,
    downed: false,
    hitAt: 0,
    hitHead: false,
    hurtAt: 0,
    respawnIn: 0,
  };
  readonly net = new NetClient();
  readonly remote: RemoteWorld;
  readonly input: Input;
  readonly layout: CityLayout;
  /** Who is playing: login token and display name (from the login screen). */
  private readonly session: GameSession;

  private readonly fly: OrbitControls | null = null;
  private readonly textures: Textures;
  private readonly sky: DayNight;
  private readonly city: CityView;
  private physics: Physics | null = null;
  private player: LocalPlayer | null = null;
  private follow: FollowCamera | null = null;
  private vehicles: VehicleManager | null = null;
  private combat: Combat | null = null;
  /** When the wait while down, or the healing in a bed, ends (performance.now()). */
  private downedEnd = 0;
  /** Our hospital bed, while in it. */
  private bed: Bed | null = null;
  /** The seat we're on, while on one. */
  private chair: Seat | null = null;
  private standingUp = false;
  /** Fell from a car: down until then, then getting up until the other. */
  private fallUntil = 0;
  private risingUntil = 0;
  /** A seat request is in flight (online): don't send another. */
  private seatPending = false;
  /** Everything the player can use (interactions.ts): cars, the info kiosk, later more. */
  readonly interactions = new Interactions();
  /** Where the player is being guided (waypoint.ts): a map mark, a job's stop, the tutorial. */
  readonly waypoints: Waypoints;
  /** The player's job shift (from the server), or null. */
  job: JobView | null = null;
  /** Rewards to show (the HUD's toast takes them), newest last. */
  readonly rewards: {
    key: number;
    cents: number;
    xp: number;
    reason: string;
    levelUp: number | null;
    at: number;
  }[] = [];
  private rewardSeq = 0;
  /** Things the player has done, counted (the tutorial watches them): 'map', 'guide', 'phone',
   * 'chat', 'emote'. */
  readonly events: Record<string, number> = {};
  /** The tutorial with Luz (tutorial.ts), while it runs. */
  tutorial: Tutorial | null = null;
  /** Luz, the city's guide, by the plaza kiosk. */
  private luz: Character | null = null;
  /** Sunny's clerk: loaded the first time anyone walks in, animated only while they're there. */
  private clerk: Character | null = null;
  private clerkAsked = false;
  /** Opens the mining swing for a point (set by the HUD). */
  onTiming: (point: number) => void = () => {};
  /** Opens the city guide (set by the HUD). */
  onGuide: () => void = () => {};
  /** Opens the car picker for a car park's point (set by the HUD). */
  onParking: (point: number) => void = () => {};
  /** Fuel and condition (0–1) of the cars the server tells us about: driven, or our own. */
  readonly carCondition = new Map<number, { fuel: number; health: number }>();
  /** A car's fuel or condition changed (the car park's sheet listens). */
  onCarCondition: () => void = () => {};
  /** A taxi: called, under way (for `seconds`), or turned down (`text` says why). */
  onRide: (ride: Ride) => void = () => {};
  private rideTo = '';
  /** Opens the Gun Store counter or the black market (their point). */
  onGunStore: (point: number) => void = () => {};
  /** The Hospital's counter, and an applications computer (at this building). */
  onCounter: () => void = () => {};
  /** Sunny's till. */
  onTill: () => void = () => {};
  onComputer: (service: ServiceId) => void = () => {};
  /** A join point: how to join this faction. */
  onJoin: (faction: FactionId) => void = () => {};
  /** Opens the phone on a screen (set by the phone). */
  onPhone: (screen: string) => void = () => {};
  /** Opens the dealership's showroom (its desk's point). */
  onDealer: (point: number) => void = () => {};
  /** The car park marker the player is standing in (it opened the picker), or -1. */
  private parkingInside = -1;
  private night = 0;
  private clock: ClockAnchor;
  /** `clock` came from the server and is anchored on its timeline. */
  private clockOnServer = false;
  /** FLAG.ARMED / FLAG.AIM for the state we report. */
  private stanceFlags = 0;
  private reconnectTimer = 0;
  /** ms before the next reconnect attempt; 0 while connected. */
  private reconnectDelay = 0;
  private disposed = false;
  readonly voice = new Voice();
  private connects = 0;
  private sendAccumulator = 0;
  private frameNo = 0;
  /** Frames drawn so far (dev tools: scripts/shot.mjs SHOT_PROFILE). */
  get frameCount(): number {
    return this.frameNo;
  }
  private lastFrame = performance.now();
  private accumulator = 0;
  private fpsFrames = 0;
  private fpsSince = performance.now();
  /** Auto graphics' resolution scale (1 = the tier's full resolution). */
  private resolutionScale = 1;
  /** Proximity chat: the lines heard lately (oldest first), and the bubbles over speakers. */
  readonly chat: ChatLine[] = [];
  private chatSeq = 0;
  private readonly bubbles = new Map<number, { text: string; until: number }>();
  /** Dev (?mapshot): the camera that draws the map's image. */
  private mapCamera: THREE.OrthographicCamera | null = null;
  /** The city's ambience, footsteps and engines (made on entering the city). */
  private sounds: GameSounds | null = null;
  /** Which of init's steps are done (the loading screen's progress). */
  private readonly entry = { physics: false, character: false, connected: false };
  private readonly governor: ResolutionGovernor;
  private resolutionCheckedAt = 0;
  /** Time between frames since the last resolution check (ms). */
  private readonly frameGaps: number[] = [];
  /** When the resolution may start to change: entering the city is no measure of the device. */
  private adaptFrom = Infinity;
  /** Nothing is drawn behind the loading screen: it only slows the loading. */
  private drawing = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, session: GameSession = { token: '', name: '' }) {
    this.session = session;
    this.hud.money = session.balance ?? null;
    this.hud.xp = session.xp ?? null;
    this.quality = detectQuality();
    this.governor = new ResolutionGovernor(this.quality.minFrameMs);
    // Frosted-glass UI blurs the moving city behind it every frame: too costly on low-end GPUs.
    document.documentElement.style.setProperty(
      '--glass-blur',
      this.quality.tier === 'low' ? '0px' : '14px',
    );
    const params = new URLSearchParams(location.search);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: params.has('shot'),
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    // Checking each shader for errors after compiling it makes the browser finish every
    // compile there and then (no background compiling): a stall per new material. Dev only.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    initTextures(this.renderer);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The physical sky is bright; three's sky example also runs exposure near 0.5.
    this.renderer.toneMappingExposure = 0.5;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, this.quality.viewDistance);
    // Never moved. Left automatic it would make three.js redo every object under it each frame.
    this.scene.matrixAutoUpdate = false;
    // Dev (?mapshot): draws the map's image (scripts/map-image.mjs): the island from above.
    if (import.meta.env.DEV && params.has('mapshot')) {
      SHOW_ALL_TILES.on = true;
      const h = (WORLD.x1 - WORLD.x0) / 2;
      this.mapCamera = new THREE.OrthographicCamera(-h, h, h, -h, 1, 3000);
      this.mapCamera.position.set((WORLD.x0 + WORLD.x1) / 2, 1500, (WORLD.z0 + WORLD.z1) / 2);
      // North (−z) at the top of the picture.
      this.mapCamera.up.set(0, 0, -1);
      this.mapCamera.lookAt((WORLD.x0 + WORLD.x1) / 2, 0, (WORLD.z0 + WORLD.z1) / 2);
    }
    if (params.has('fly')) {
      const fly = new OrbitControls(this.camera, canvas);
      fly.enableDamping = true;
      fly.maxPolarAngle = Math.PI * 0.495;
      const [cx = NaN, cy = NaN, cz = NaN, tx = NaN, ty = NaN, tz = NaN] = (params.get('cam') ?? '')
        .split(',')
        .map(Number);
      if ([cx, cy, cz, tx, ty, tz].every(Number.isFinite)) {
        this.camera.position.set(cx, cy, cz);
        fly.target.set(tx, ty, tz);
      } else {
        this.camera.position.set(60, 45, 70);
        fly.target.set(-60, 12, -60);
      }
      fly.update();
      this.fly = fly;
    }

    // Until the server says otherwise, the city's clock from the shared epoch (same as the
    // server's), or a fixed hour for screenshots.
    const fixedHour = params.get('t');
    this.clock =
      fixedHour !== null
        ? { realMs: Date.now(), gameMinutes: Number(fixedHour) * 60, rate: 0 }
        : CLOCK_EPOCH;

    this.input = new Input(canvas);
    this.layout = generateCity();
    this.waypoints = new Waypoints(this.scene, this.layout);
    // Dev (?job=courier|mining): a sample shift offline, for screenshots of the job HUD.
    const demoJob = import.meta.env.DEV ? params.get('job') : null;
    if (demoJob) window.setTimeout(() => this.demoJob(demoJob), 1500);
    // Dev (?mark=x,z): a waypoint from the start, for screenshots.
    const [mx = NaN, mz = NaN] = (params.get('mark') ?? '').split(',').map(Number);
    if (import.meta.env.DEV && Number.isFinite(mx) && Number.isFinite(mz))
      this.waypoints.set({ x: mx, z: mz, label: 'Marked spot', by: 'map' });
    this.textures = new Textures(this.quality);
    this.sky = new DayNight(this.scene, this.renderer, this.quality);
    this.city = buildCity(this.layout, this.textures, this.quality);
    this.scene.add(this.city.group);
    this.scene.add(this.interiors.group);
    this.remote = new RemoteWorld(this.scene);

    this.stats = {
      fps: 0,
      frameMs: 0,
      drawCalls: 0,
      triangles: 0,
      textures: 0,
      geometries: 0,
      heapMB: 0,
      tier: this.quality.auto ? `auto ${this.quality.tier}` : this.quality.tier,
      resolution: 100,
    };

    if (import.meta.env.DEV) (window as Window & { __fr33?: Game }).__fr33 = this;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  /**
   * Loads what play needs (physics, the player's character, textures) and resolves when the
   * world is ready to enter, so the loading screen waits on real work.
   */
  async init(): Promise<void> {
    // Dev (?at=x,z,yaw): start somewhere else, for screenshots (offline only: the server
    // places players online).
    const [ax = NaN, az = NaN, ayaw = 0] = (new URLSearchParams(location.search).get('at') ?? '')
      .split(',')
      .map(Number);
    const spawn =
      import.meta.env.DEV && Number.isFinite(ax) && Number.isFinite(az)
        ? { x: ax, z: az, yaw: ayaw }
        : (this.layout.playerSpawns[0] ?? { x: 0, z: 0, yaw: 0 });
    const done =
      <T>(step: keyof typeof this.entry) =>
      (v: T) => {
        this.entry[step] = true;
        return v;
      };
    const [physics, character] = await Promise.all([
      Physics.create(this.layout).then(done('physics')),
      Character.load(
        decodeAppearance(this.session.look ?? encodeAppearance(DEFAULT_APPEARANCE)),
        0,
        0,
        decodeGear(this.session.gear ?? 0),
      ).then(done('character')),
      this.textures.ready(),
    ]);
    this.physics = physics;
    this.vehicles = new VehicleManager(this.scene, physics);
    this.remote.onVehicle = (b) => this.vehicles?.upsertRemote(b);
    // Drivers are drawn at the wheel of the car they drive.
    this.remote.carOf = (driver) => {
      for (const c of this.vehicles?.cars.values() ?? [])
        if (c.driver === driver) return { pos: c.pos, yaw: c.yaw, id: c.model.spec.id };
      return null;
    };
    this.remote.carById = (id) => {
      const c = this.vehicles?.cars.get(id);
      return c ? { pos: c.pos, yaw: c.yaw, id: c.model.spec.id } : null;
    };
    this.remote.onVehicleGone = (id) => this.vehicles?.remove(id);
    if (this.fly) {
      this.vehicles.spawnOffline(this.offlineCars());
      this.drawing = true;
      return;
    }
    const player = new LocalPlayer(physics, { x: spawn.x, y: SLAB_Y, z: spawn.z, yaw: spawn.yaw });
    player.character = character;
    this.combat = new Combat(this.scene, physics, this.net);
    // The pistol rides in the right hand, pointing along the forearm.
    for (const gun of this.combat.gunMeshes) character.holdInRightHand(gun);
    this.scene.add(character.root);
    this.player = player;
    this.addInteractions();
    // The tutorial, for a character who hasn't finished or skipped it (dev: ?tutorial).
    const step =
      import.meta.env.DEV && location.search.includes('tutorial')
        ? 'welcome'
        : this.session.tutorial;
    if (step && isTutorialStep(step) && step !== 'done' && step !== 'skipped')
      this.tutorial = new Tutorial(this, step);
    void this.placeLuz();
    this.sounds = new GameSounds();
    this.follow = new FollowCamera(this.camera, physics);
    this.follow.face(spawn.yaw);
    // The car models first, so their shaders compile with the rest.
    await this.vehicles?.ready();
    this.scene.add(careShaders());
    await this.precompile();
    await this.connect();
    this.entry.connected = true;
    await this.warmUp();
    this.adaptFrom = performance.now() + ENTRY_SETTLE_MS;
    // The account's blocks (in the background: entry doesn't wait for them).
    if (this.session.apiToken)
      void this.session
        .apiToken()
        .then(fetchBlocks)
        .then((names) => this.setBlocks(names))
        .catch((e: unknown) => console.warn('blocks not loaded', e));
  }

  /**
   * Compiles every shader the scene can need while the loading screen is up, hidden things
   * (night lights, stars, far tiles) included, so none compiles mid-game: a compile is a stall
   * of tens to hundreds of milliseconds on a phone. In the background where the browser can.
   */
  private async precompile() {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      console.warn('precompile failed', e);
    } finally {
      for (const o of hidden) o.visible = false;
    }
  }

  /**
   * Sends what's around the player to the GPU while the loading screen is still up, facing each
   * way in turn, into one pixel (the same shaders, nothing to fill). Left to the game's first
   * frames this was a stall of a second on a laptop, and more whenever the player looked round.
   */
  private async warmUp() {
    this.frame(performance.now());
    const size = this.renderer.getSize(new THREE.Vector2());
    const facing = this.camera.quaternion.clone();
    this.renderer.setViewport(0, 0, 1, 1);
    for (let turn = 0; turn < 4 && !this.disposed; turn += 1) {
      this.camera.quaternion.copy(facing);
      this.camera.rotateY((turn * Math.PI) / 2);
      this.renderer.render(this.scene, this.camera);
      await new Promise((resolve) => setTimeout(resolve));
    }
    if (this.disposed) return;
    this.camera.quaternion.copy(facing);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.drawing = true;
  }

  /** Plays an emote (EMOTES) and shows it to everyone in view; moving ends it. */
  emote(index: number): void {
    const e = EMOTES[index];
    const anim = this.player?.character?.animator;
    if (!e || !anim || this.vehicles?.driven || this.combat?.downed || this.chair) return;
    this.note('emote');
    void anim.play(e.clip, e.loop);
    if (this.net.connected) this.net.send({ type: 'emote', emote: index });
  }

  /** Luz stands beside the info kiosk, facing the plaza's south side, idling. */
  private async placeLuz() {
    const kiosk = this.layout.points.find((p) => p.kind === 'info');
    if (!kiosk) return;
    const look = {
      ...DEFAULT_APPEARANCE,
      body: 'female' as const,
      face: 5,
      outfit: 9,
      skin: 0,
      top: 0,
      height: 2,
    };
    const luz = await Character.load(look, 1).catch(() => null);
    if (!luz) return;
    luz.root.position.set(kiosk.x + 2.1, SLAB_Y + FOOT_LIFT, kiosk.z - 0.4);
    luz.root.rotation.y = 0.35;
    this.scene.add(luz.root);
    this.luz = luz;
  }

  private async addClerk(room: RoomId, at: { x: number; z: number; yaw: number }) {
    if (this.clerkAsked) return;
    this.clerkAsked = true;
    const look = { ...DEFAULT_APPEARANCE, body: 'female' as const, face: 2, outfit: 4, skin: 2 };
    const clerk = await Character.load(look, 1).catch(() => null);
    if (!clerk) return;
    clerk.root.position.set(at.x, FOOT_LIFT, at.z);
    clerk.root.rotation.y = at.yaw;
    this.interiors.place(room, clerk.root);
    this.clerk = clerk;
  }

  /** Saves the tutorial's step (logged in); finishing shows its reward. */
  saveTutorial(step: string): void {
    const token = this.session.apiToken;
    if (!token) return;
    void token()
      .then((t) => saveTutorial(t, step))
      .then(
        (r) => {
          if (r.reward && r.reward.cents + r.reward.xp > 0)
            this.onReward({ ...r.reward, reason: 'Tutorial finished' });
        },
        (e: unknown) => console.warn('tutorial not saved', e),
      );
  }

  /** Counts something the player did (for the tutorial). */
  note(event: string): void {
    this.events[event] = (this.events[event] ?? 0) + 1;
  }

  /** Says `text` to the players nearby (proximity chat; the server echoes it back). */
  say(text: string): void {
    const line = text.trim();
    if (line) this.note('chat');
    if (line && this.net.connected) this.net.send({ type: 'chat', text: line });
  }

  /** A line said nearby: into the chat feed, and a bubble over the speaker for a few seconds. */
  private heard(from: number, text: string) {
    if (from === NO_ENTITY) {
      this.chat.push({
        key: ++this.chatSeq,
        from,
        name: 'Server',
        text,
        you: false,
        system: true,
        at: performance.now(),
      });
      if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
      return;
    }
    const you = from === this.net.you;
    const sender = this.remote.bodies.get(from)?.name;
    if (!you && sender && this.isBlocked(sender)) return;
    const name = you
      ? this.session.name || 'You'
      : (this.remote.bodies.get(from)?.name ?? 'Someone');
    this.chat.push({ key: ++this.chatSeq, from, name, text, you, at: performance.now() });
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.bubbles.set(from, { text, until: performance.now() + BUBBLE_MS });
  }

  /**
   * Where the prompt's marker is on screen (px), when it has a place in the world in front of
   * the camera; null otherwise.
   */
  promptMarker(width: number, height: number): { key: string; x: number; y: number } | null {
    const now = this.interactions.current;
    if (!now?.at) return null;
    const p = new THREE.Vector3(now.at.x, now.at.y, now.at.z);
    p.project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return { key: now.key, x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
  }

  /**
   * Speech bubbles to draw now: the text and where the speaker's head is on screen (px), for
   * those in front of the camera.
   */
  speechBubbles(
    width: number,
    height: number,
  ): { key: number; text: string; x: number; y: number }[] {
    const now = performance.now();
    const out: { key: number; text: string; x: number; y: number }[] = [];
    const p = new THREE.Vector3();
    for (const [id, b] of this.bubbles) {
      if (b.until < now) {
        this.bubbles.delete(id);
        continue;
      }
      const body = id === this.net.you ? this.player?.position : this.remote.bodies.get(id)?.pos;
      if (!body) continue;
      // Over the name tag (others) or the head (yourself).
      p.set(body.x, body.y + (id === this.net.you ? 1.95 : 2.3), body.z);
      if (p.distanceTo(this.camera.position) > 40) continue;
      p.project(this.camera);
      if (p.z > 1 || p.z < -1) continue;
      out.push({ key: id, text: b.text, x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height });
    }
    return out;
  }

  /**
   * Name tags over the players nearby (within 25 m, in front of the camera): where on screen,
   * how clear (fading out from 18 m), and whether they're talking.
   */
  nameTags(
    width: number,
    height: number,
  ): {
    id: number;
    name: string;
    x: number;
    y: number;
    alpha: number;
    talking: boolean;
    faction: FactionId | null;
    level: number;
  }[] {
    const out: {
      id: number;
      name: string;
      x: number;
      y: number;
      alpha: number;
      talking: boolean;
      faction: FactionId | null;
      level: number;
    }[] = [];
    const p = new THREE.Vector3();
    for (const b of this.remote.bodies.values()) {
      if (b.kind !== ENTITY_KIND.PLAYER || !b.name || modeOf(b.state) === MODE.SEATED) continue;
      if (this.isBlocked(b.name)) continue;
      const d = b.pos.distanceTo(this.camera.position);
      if (d > 25) continue;
      p.set(b.pos.x, b.pos.y + 2.02, b.pos.z).project(this.camera);
      if (p.z > 1 || p.z < -1) continue;
      out.push({
        id: b.id,
        name: b.name,
        x: ((p.x + 1) / 2) * width,
        y: ((1 - p.y) / 2) * height,
        alpha: Math.min(1, (25 - d) / 7),
        talking: (b.state & FLAG.TALKING) !== 0,
        faction: b.faction,
        level: b.level,
      });
    }
    return out;
  }

  /** Character names (lower case) this account has blocked: no chat, voice or tag from them. */
  private readonly blocked = new Set<string>();
  /** Whether blocks and reports are available (playing logged in). */
  get canModerate(): boolean {
    return !!this.session.apiToken;
  }
  isBlocked(name: string): boolean {
    return this.blocked.has(name.toLowerCase());
  }

  /** Blocks or unblocks a player by their character's name (saved to the account). */
  async block(name: string, on: boolean): Promise<void> {
    if (!this.session.apiToken) return;
    this.setBlocks(await setBlock(await this.session.apiToken(), name, on));
  }

  /** The bank (the phone's app): balance and history; updates the HUD's money. */
  async statement(before?: number): Promise<Statement> {
    if (import.meta.env.DEV && !this.session.apiToken && location.search.includes('phone='))
      return demoStatement();
    if (!this.session.apiToken) throw new Error('Log in to use the bank.');
    const s = await fetchStatement(await this.session.apiToken(), before);
    this.hud.money = s.balance;
    return s;
  }

  /** The Messages app; keeps count of what's unread for the phone's badge. */
  async conversations() {
    if (!this.session.apiToken) throw new Error('Log in for messages.');
    const r = await fetchConversations(await this.session.apiToken());
    this.hud.unreadMessages = r.unread;
    return r;
  }

  async thread(name: string) {
    if (!this.session.apiToken) throw new Error('Log in for messages.');
    return fetchThread(await this.session.apiToken(), name);
  }

  async sendMessage(to: string, text: string) {
    if (!this.session.apiToken) throw new Error('Log in for messages.');
    return sendDirectMessage(await this.session.apiToken(), to, text);
  }

  /** The Rewards app; keeps count of what's waiting for the phone's badge. */
  async daily(): Promise<DailyStatus> {
    if (!this.session.apiToken) throw new Error('Log in for daily rewards.');
    const s = await fetchDaily(await this.session.apiToken());
    this.hud.dailyReady = waiting(s);
    return s;
  }

  async claimDaily(body: { what: string; level?: number }): Promise<DailyPaid> {
    if (!this.session.apiToken) throw new Error('Log in for daily rewards.');
    const r = await claimDaily(await this.session.apiToken(), body);
    if (r.cents > 0 || r.xp > 0) void this.statement().catch(() => {});
    this.hud.xp = r.totalXp;
    return r;
  }

  /** Level, XP and recent rewards (the phone's progress app); updates the HUD's XP. */
  async progress(): Promise<Progress> {
    if (import.meta.env.DEV && !this.session.apiToken && location.search.includes('phone=')) {
      const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      this.hud.xp = 412;
      return {
        xp: 412,
        level: 3,
        into: 166,
        next: 198,
        history: [
          {
            id: 3,
            source: 'jobs',
            reason: 'Delivery to Grand Ave',
            cents: 42_500,
            xp: 60,
            at: ago(6),
          },
          { id: 2, source: 'jobs', reason: 'Copper ore sold', cents: 18_000, xp: 45, at: ago(50) },
          {
            id: 1,
            source: 'tutorial',
            reason: 'Tutorial finished',
            cents: 50_000,
            xp: 250,
            at: ago(90),
          },
        ],
      };
    }
    if (!this.session.apiToken) throw new Error('Log in to see your progress.');
    const p = await fetchProgress(await this.session.apiToken());
    this.hud.xp = p.xp;
    return p;
  }

  /** The cars the player owns (the phone's Garage app). */
  async garage(): Promise<GarageCar[]> {
    if (!this.session.apiToken)
      return [
        {
          id: 0,
          model: 1,
          name: 'Compact',
          expiresAt: new Date(Date.now() + 2.2 * 86_400_000).toISOString(),
        },
      ];
    return (await fetchGarage(await this.session.apiToken())).cars;
  }

  /** Brings one of the player's cars (the garage's id) to the car park at `point`. */
  callCar(point: number, car: number): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'call_car', point, car });
    return true;
  }

  /**
   * Stepping into a car park's marker opens the car picker, once each time in: it opens again
   * only after the player has walked out of it.
   */
  private checkParking(x: number, z: number) {
    // A car park's marker stands just inside its entrance; the dealership's on its desk.
    const markerOf = (p: (typeof this.layout.points)[number]) =>
      p.kind === 'dealer' ? p : parkingMarker(p);
    const inside = this.layout.points[this.parkingInside];
    if (inside) {
      const m = markerOf(inside);
      if (Math.hypot(m.x - x, m.z - z) > MARKER_RADIUS + 2) this.parkingInside = -1;
      return;
    }
    this.parkingPoints ??= this.layout.points.flatMap((p, i) =>
      p.kind === 'parking' || p.kind === 'dealer' ? [i] : [],
    );
    for (const i of this.parkingPoints) {
      const p = this.layout.points[i] as (typeof this.layout.points)[number];
      const m = markerOf(p);
      if (Math.hypot(m.x - x, m.z - z) > MARKER_RADIUS) continue;
      this.parkingInside = i;
      if (p.kind === 'dealer') this.onDealer(i);
      else this.onParking(i);
      return;
    }
  }
  private parkingPoints: number[] | null = null;
  private liftPoints: number[] | null = null;
  /** The door marker we're standing on (-1 none), and all of them. */
  private doorInside = -1;
  private doorRestUntil = 0;
  private doorPoints: number[] | null = null;
  /** The room we're in. */
  private indoors: RoomId | null = null;
  private readonly interiors = new InteriorsView();
  /** The clothes we're in (faction and duty), once the server has said. */
  private wearing: string | null = null;
  /** The fade through a door lasts until then. */
  private fadeUntil = 0;
  /** Our faction (the server's word), for doors we can't use. */
  memberOf: string | null = null;
  /** The 911 call we're waiting on. */
  call: EmergencyCall | null = null;
  /** performance.now() until which the aim stays up after firing. */
  private aimHoldUntil = 0;

  /** Other players up and about, for the crosshair. */
  private playersInView(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const b of this.remote.bodies.values())
      if (b.kind === ENTITY_KIND.PLAYER && modeOf(b.state) !== MODE.DOWNED) out.push(b.pos);
    return out;
  }

  /** Buys a car of `model` at the dealership (`key`: this purchase's id, so a retry pays once). */
  async buyCar(model: number, key: string): Promise<{ id: number; model: number; name: string }> {
    if (!this.session.apiToken) throw new Error('Log in to buy a car.');
    const r = await buyCar(await this.session.apiToken(), model, key);
    this.hud.money = r.balance;
    return r.car;
  }

  /** Asks for a taxi to (x, z), called `to`; false when offline. Answers come to `onRide`. */
  callTaxi(x: number, z: number, to: string): boolean {
    if (!this.net.connected) return false;
    this.rideTo = to;
    this.net.send({ type: 'taxi', x, z });
    this.onRide({ state: 'calling', to, seconds: 0, cents: 0, text: '' });
    return true;
  }

  /** The driven car's fuel and condition to the dashboard and its engine. */
  private applyCondition() {
    const c = this.carCondition.get(this.vehicles?.drivenId ?? NO_ENTITY);
    const fuel = c?.fuel ?? 1;
    const health = c?.health ?? 1;
    this.hud.fuel = fuel;
    this.hud.carHealth = health;
    if (this.vehicles?.driven) this.vehicles.driven.power = enginePower(fuel, health);
  }

  /** The player's own car in the world (their name is on it), with its fuel and condition. */
  ownCarOut(): {
    id: number;
    model: number;
    x: number;
    z: number;
    fuel: number;
    health: number;
  } | null {
    const mine = `${this.session.name}'s car`;
    for (const car of this.vehicles?.cars.values() ?? []) {
      if (car.remote?.name !== mine) continue;
      const c = this.carCondition.get(car.id) ?? { fuel: 1, health: 1 };
      return { id: car.id, model: car.model.model, x: car.pos.x, z: car.pos.z, ...c };
    }
    return null;
  }

  /** Fuel or a repair (protocol SERVICE) for the player's own car at the car park at `point`. */
  service(point: number, what: number): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'service', point, what });
    // The bank has the new balance once the charge has gone through.
    window.setTimeout(() => void this.statement().catch(() => {}), 1500);
    return true;
  }

  /** The phone's Faction app: status, applying, the training quiz, leaving. */
  async factions(): Promise<FactionStatus> {
    if (!this.session.apiToken) throw new Error('Log in to join a faction.');
    return fetchFactions(await this.session.apiToken());
  }
  /** The computer's applications. */
  async desk(): Promise<FactionDesk> {
    if (!this.session.apiToken) throw new Error('Log in first.');
    return fetchDesk(await this.session.apiToken());
  }

  /** The gangs, the board, and yours. */
  async gangs(): Promise<GangStatus> {
    if (!this.session.apiToken) throw new Error('Log in first.');
    return fetchGangs(await this.session.apiToken());
  }

  async gangAction(
    action: 'create' | 'join' | 'leave' | 'decide',
    body: Record<string, unknown> = {},
  ): Promise<GangStatus> {
    if (!this.session.apiToken) throw new Error('Log in first.');
    return gangAction(await this.session.apiToken(), action, body);
  }

  /** A pin on the map at a public building's door. */
  pinBuilding(service: ServiceId): boolean {
    const p = this.layout.points.find((q) => q.kind === 'entrance' && q.service === service);
    if (!p) return false;
    this.waypoints.set({ x: p.x, z: p.z, label: p.name ?? 'Here', by: 'map' });
    return true;
  }

  async applyFaction(faction: FactionId, note: string): Promise<FactionStatus> {
    if (!this.session.apiToken) throw new Error('Log in to join a faction.');
    return applyFaction(await this.session.apiToken(), faction, note);
  }
  async factionQuiz(answers: number[]) {
    if (!this.session.apiToken) throw new Error('Log in to join a faction.');
    return takeFactionQuiz(await this.session.apiToken(), answers);
  }
  async leaveFaction(): Promise<FactionStatus> {
    if (!this.session.apiToken) throw new Error('Log in first.');
    return leaveFaction(await this.session.apiToken());
  }

  /** The player's character name (the market marks their own listings). */
  get playerName(): string {
    return this.session.name;
  }

  /** The car market (the phone's Market app): listings, selling, taking down, buying. */
  listings(): Promise<Listing[]> {
    return fetchListings();
  }
  async market(what: 'list' | 'withdraw' | 'buy', body: object): Promise<void> {
    if (!this.session.apiToken) throw new Error('Log in to trade cars.');
    await marketCall(await this.session.apiToken(), what, body);
    if (what === 'buy') void this.statement().catch(() => {});
  }

  /** The inbox's notices; `read` marks them read (the phone's Inbox app). */
  async inbox(read = false) {
    if (!this.session.apiToken) return { notices: [], unread: 0 };
    const r = await fetchInbox(await this.session.apiToken(), read);
    this.hud.unread = read ? 0 : r.unread;
    return r;
  }

  /** Runs a chat command for the player (the phone's buttons: /duty, /911, /accept…). */
  command(text: string): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'chat', text });
    return true;
  }

  /** On duty as police or a medic (the server's word), else null. */
  get duty(): 'police' | 'medical' | null {
    return this.combat?.duty ?? null;
  }

  /** The open calls for whoever's on duty (protocol `dispatch`). */
  dispatch: {
    id: number;
    text: string;
    x: number;
    z: number;
    minutes: number;
    responders: string[];
  }[] = [];

  /** What we carry, as the server last said (null offline or before it has). */
  arms(): Combat['arms'] {
    return this.combat?.arms ?? null;
  }

  /** Buys at the gun store or black market at `point` (item 0: the licence; then ARMORY.items). */
  buyArms(point: number, item: number): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'buy', point, item });
    window.setTimeout(() => void this.statement().catch(() => {}), 1500);
    return true;
  }

  /** Is an EMS worker in the Hospital with us? (The counter's cheaper then.) */
  counterStaffed(): boolean {
    for (const b of this.remote.bodies.values())
      if (b.onDuty && b.faction === 'medical' && interiorAt(b.pos.x, b.pos.z)) return true;
    return false;
  }

  /** Buys CARE item `item`. */
  buyCare(item: number): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'act', what: ACT.BUY_CARE, arg: item });
    window.setTimeout(() => void this.statement().catch(() => {}), 1500);
    return true;
  }

  /** Buys GOODS item `item` for `$` at the till. */
  buyGood(item: number): boolean {
    if (!this.net.connected) return false;
    this.net.send({ type: 'act', what: ACT.BUY_GOOD, arg: item });
    window.setTimeout(() => void this.statement().catch(() => {}), 1500);
    return true;
  }

  /** The login token and signer USDC needs, or null for guests and offline play. */
  usdcAccess(): {
    token: () => Promise<string>;
    sign: (hash: `0x${string}`) => Promise<string>;
  } | null {
    const { apiToken, signHash } = this.session;
    return apiToken && signHash ? { token: apiToken, sign: signHash } : null;
  }

  /** Uses CARE item `item`. */
  useCare(item: number): void {
    if (this.net.connected) this.net.send({ type: 'act', what: ACT.USE_CARE, arg: item });
  }

  /** Directions to the dealership. */
  guideToDealer(): string | null {
    const p = this.layout.points.find((q) => q.kind === 'dealer');
    if (!p) return null;
    this.waypoints.set({ x: p.x, z: p.z, label: p.name ?? 'Dealership', by: 'map' });
    return p.name ?? 'Dealership';
  }

  /** Directions to the nearest car park. */
  guideToParking(): string | null {
    const at = this.whereabouts();
    if (!at) return null;
    let best: (typeof this.layout.points)[number] | null = null;
    for (const p of this.layout.points)
      if (
        p.kind === 'parking' &&
        (!best || Math.hypot(p.x - at.x, p.z - at.z) < Math.hypot(best.x - at.x, best.z - at.z))
      )
        best = p;
    if (!best) return null;
    this.waypoints.set({ x: best.x, z: best.z, label: best.name ?? 'Car park', by: 'map' });
    return best.name ?? 'Car park';
  }

  /** Pays another character from the bank. */
  async pay(p: { to: string; cents: number; note: string; key: string }): Promise<string> {
    if (!this.session.apiToken) throw new Error('Log in to use the bank.');
    const r = await sendPayment(await this.session.apiToken(), p);
    this.hud.money = r.balance;
    return r.to;
  }

  /** Names of the players around (for the bank's "send to"), nearest first. */
  nearbyNames(): string[] {
    const me = this.player?.position;
    if (!me) return [];
    return [...this.remote.bodies.values()]
      .filter((b) => b.kind === ENTITY_KIND.PLAYER && b.name && !this.isBlocked(b.name))
      .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
      .slice(0, 6)
      .map((b) => b.name);
  }

  /** Reports a player by their character's name. */
  async report(name: string, reason: string, details: string): Promise<void> {
    if (!this.session.apiToken) throw new Error('Log in to report players.');
    await sendReport(await this.session.apiToken(), { name, reason, details });
  }

  private setBlocks(names: string[]) {
    this.blocked.clear();
    for (const n of names) this.blocked.add(n.toLowerCase());
    this.applyBlocks();
  }

  /** Blocked players in view: muted (voice), and their tags and chat hidden elsewhere. */
  private applyBlocks() {
    for (const b of this.remote.bodies.values())
      if (b.name && this.isBlocked(b.name)) this.voice.muted.add(b.id);
  }

  /** Mutes or unmutes a player's voice for this session. */
  setMuted(id: number, on: boolean): void {
    if (on) this.voice.muted.add(id);
    else this.voice.muted.delete(id);
  }
  isMuted(id: number): boolean {
    return this.voice.muted.has(id);
  }

  /** Where the player is and which way the camera looks (yaw), for the map. Null before entry. */
  whereabouts(): { x: number; z: number; yaw: number } | null {
    const car = this.vehicles?.driven;
    const at = car ? car.position : this.player?.position;
    if (!at || !this.follow) return null;
    return { x: at.x, z: at.z, yaw: this.follow.yaw };
  }

  /**
   * World-entry progress for the loading screen: init's steps (textures by count), and what
   * it's doing now (waking or joining the server can take a while on the free plan).
   */
  loadProgress(): { fraction: number; status: string } {
    const t = this.textures.progress();
    const steps: [number, number, string][] = [
      [this.entry.physics ? 1 : 0, 3, 'Building the city'],
      [t.total > 0 ? t.done / t.total : 0, 3, 'Laying the streets'],
      [this.entry.character ? 1 : 0, 2, 'Getting your character ready'],
      [
        this.entry.connected ? 1 : 0,
        1,
        this.hud.net.startsWith('waking')
          ? 'Waking the server (about a minute)'
          : 'Joining Horizon',
      ],
    ];
    let done = 0;
    let all = 0;
    for (const [f, w] of steps) {
      done += f * w;
      all += w;
    }
    const current = steps.find(([f]) => f < 1);
    return { fraction: done / all, status: current ? current[2] : 'Entering Los Soles' };
  }

  /** Offline, the cars the server would have: the dealership's. */
  private offlineCars(): VehicleSpawn[] {
    const onShow = (this.layout.dealership?.display ?? []).map((s, i) => ({
      ...s,
      model: DEALER_MODELS[i] ?? 0,
      color: 0,
    }));
    return onShow;
  }

  /** Joins Horizon; on failure the game stays playable offline and says why. */
  private async connect(): Promise<void> {
    const params = new URLSearchParams(location.search);
    if (params.has('offline')) {
      this.hud.net = 'offline';
      this.vehicles?.spawnOffline(this.offlineCars());
      return;
    }
    const url = worldUrl();
    const name =
      params.get('name') ??
      (this.session.name || `Guest ${Math.floor(Math.random() * 9000 + 1000)}`);
    this.net.onMessage = (m) => this.onServer(m);
    this.net.onClose = (reason, code) => {
      this.hud.net = `offline: ${reason}`;
      void this.voice.disconnect();
      // Carry the time of day on from the server's timeline to the local clock.
      this.clock = { ...this.clock, realMs: Date.now(), gameMinutes: this.gameMinutes() };
      this.clockOnServer = false;
      if (this.vehicles?.driven) this.leaveCar(false);
      this.remote.clear();
      this.vehicles?.clear();
      this.vehicles?.spawnOffline(this.offlineCars());
      // A dropped connection or a restarted server (the free plan restarts whenever it likes):
      // come back by ourselves. Codes 4000+ are the server turning us away; don't insist.
      if (code < 4000) this.scheduleReconnect();
    };
    // Back from a drop: the offline stand-in cars give way to the server's.
    if (this.vehicles?.driven) this.leaveCar(false);
    this.vehicles?.clear();
    try {
      await wakeServer(url, () => {
        this.hud.net = 'waking the server (about a minute)';
      });
      this.hud.net = 'connecting';
      // The first connect uses the login's token; reconnects get a fresh one.
      const token =
        this.connects++ > 0 && this.session.renew ? await this.session.renew() : this.session.token;
      const welcome = await this.net.connect(url, name, token);
      this.setClock(welcome.clock);
      this.player?.place(welcome.spawn.x, welcome.spawn.y, welcome.spawn.z, welcome.spawn.yaw);
      this.follow?.face(welcome.spawn.yaw);
      this.hud.net = 'online';
      this.reconnectDelay = 0;
    } catch (e) {
      this.hud.net = `offline: ${e instanceof Error ? e.message : String(e)}`;
      this.vehicles?.spawnOffline(this.offlineCars());
      const refused = e instanceof ServerRefused;
      if (refused && e.code === ERROR_CODE.BAD_VERSION) reloadForUpdate();
      if (!refused || e.code === ERROR_CODE.SERVER_FULL) this.scheduleReconnect();
    }
  }

  /** Tries again after 1, 2, 4… up to 30 seconds. */
  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay ? this.reconnectDelay * 2 : 1000);
    const reason = this.hud.net;
    this.hud.net = `${reason} · retrying in ${Math.round(this.reconnectDelay / 1000)} s`;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      void this.connect();
    }, this.reconnectDelay);
  }

  private onServer(m: ServerMessage) {
    switch (m.type) {
      case 'enter':
        this.remote.enter(m);
        break;
      case 'leave':
        this.remote.leave(m.id);
        break;
      case 'snapshot':
        this.remote.snapshot(m.serverTime, m.entities);
        break;
      case 'seat': {
        this.remote.seat(m.vehicle, m.driver);
        const v = this.vehicles;
        if (m.driver === this.net.you && v && !v.driven) {
          this.seatPending = false;
          this.takeWheel(m.vehicle);
        } else if (v?.driven && m.vehicle === v.drivenId && m.driver !== this.net.you) {
          this.leaveCar(false);
        }
        break;
      }
      case 'passenger':
        this.remote.passenger(m.player, m.vehicle, m.seat);
        if (m.player === this.net.you) this.setRide(m.seat ? m : null);
        break;
      case 'correction': {
        // Driving, it's the car the server turned down: back to where it last accepted it.
        // Ignored, the car drove on where the server never saw it, and getting out put the
        // player back where the server last had it (kilometres away, under a freeway).
        const car = this.vehicles?.driven;
        if (car) {
          // Up the ramp from a garage to the street.
          if (interiorAt(car.position.x, car.position.z) !== interiorAt(m.x, m.z)) {
            this.fadeUntil = performance.now() + DOOR_FADE_MS;
            this.follow?.face(m.yaw);
          }
          car.teleport(m.x, m.y, m.z, m.yaw);
        } else {
          // Through a door: facing the way in or out, or running on would be walking sideways
          // along the lobby with the view on a wall.
          const p = this.player?.position;
          const through = p && interiorAt(p.x, p.z) !== interiorAt(m.x, m.z);
          this.player?.place(m.x, m.y, m.z, through ? m.yaw : undefined);
          if (through) this.follow?.face(m.yaw);
        }
        break;
      }
      case 'clock':
        this.setClock(m);
        break;
      case 'shot_fx':
        this.combat?.remoteShot(m);
        this.remote.fired(m.shooter, m.weapon, m.pitch);
        this.sounds?.shot(m.weapon, new THREE.Vector3(m.x, m.y, m.z));
        break;
      case 'hit':
        this.combat?.onHit(m, this.net.you);
        if (m.target === this.net.you && m.hp > 0) this.player?.character?.animator?.hit();
        else this.remote.hit(m.target, m.hp);
        break;
      case 'health':
        this.onHealth(m.hp, m.downed);
        break;
      case 'voice':
        void this.voice.connect(m.url, m.token);
        break;
      case 'chat':
        this.heard(m.from, m.text);
        break;
      case 'emote':
        // Ours only when the server chose it: patching up.
        if (m.from === this.net.you) {
          const e = EMOTES[m.emote];
          if (e) this.player?.character?.emote(e.clip, e.loop);
        } else this.remote.emote(m.from, m.emote);
        break;
      case 'job':
        this.onJob(m.state);
        break;
      case 'reward':
        this.onReward(m);
        break;
      case 'car': {
        // A knock in the car we drive: the crash's sound, as big as the damage.
        const was = this.carCondition.get(m.vehicle)?.health;
        if (was !== undefined && m.vehicle === this.vehicles?.drivenId && was - m.health > 0.02)
          this.sounds?.crash(was - m.health);
        this.carCondition.set(m.vehicle, { fuel: m.fuel, health: m.health });
        this.vehicles?.condition.set(m.vehicle, m.health);
        this.applyCondition();
        this.onCarCondition();
        break;
      }
      case 'dispatch':
        this.dispatch = JSON.parse(m.state) as Game['dispatch'];
        break;
      case 'arms': {
        const state = JSON.parse(m.state) as Parameters<Combat['setArms']>[0] & {
          faction?: string | null;
          rank?: number;
          call?: EmergencyCall | null;
          downedMs?: number;
          emsCalled?: boolean;
          bed?: Bed | null;
          seat?: Seat | null;
          duty?: string | null;
        };
        this.combat?.setArms(state);
        this.memberOf = state.faction ?? null;
        this.call = state.call ?? null;
        this.downedEnd = performance.now() + (state.downedMs ?? 0);
        this.hud.emsCalled = state.emsCalled === true;
        this.setBed(state.bed ?? null);
        this.setChair(state.seat ?? null);
        this.dress(state.faction ?? null, state.duty ?? null, state.rank ?? 0);
        break;
      }
      case 'ride':
        if (m.cents > 0 && this.hud.money !== null) this.hud.money -= m.cents;
        this.onRide({
          state: m.seconds > 0 ? 'riding' : 'refused',
          to: this.rideTo,
          seconds: m.seconds,
          cents: m.cents,
          text: m.text,
        });
        break;
      case 'error':
        this.seatPending = false;
        this.hud.net = m.message;
        break;
      default:
        break;
    }
  }

  /** Reports the local body (or the car being driven) to the server at CLIENT_SEND_HZ. */
  private sendState(dt: number, player: LocalPlayer) {
    // On a chair the server holds the body: a report of the seat crossing its reply to getting
    // up reads as walking into the furniture, and that counts against the player.
    if (!this.net.connected || this.chair) return;
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / CLIENT_SEND_HZ) return;
    this.sendAccumulator %= 1 / CLIENT_SEND_HZ;
    const car = this.vehicles?.driven;
    let pose: Pose;
    if (car) {
      const p = car.position;
      const v = car.velocity;
      const lights = this.night > 0.3 ? FLAG.LIGHTS : 0;
      const horn = this.input.drive.horn ? FLAG.HORN : 0;
      pose = {
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: car.yaw,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        state: lights | horn,
      };
    } else {
      const p = player.position;
      const v = player.velocity;
      pose = {
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: player.yaw,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        state: player.mode | this.stanceFlags,
      };
    }
    this.net.sendState(pose);
  }

  private onHealth(hp: number, downed: boolean) {
    const combat = this.combat;
    if (!combat) return;
    const was = combat.downed;
    combat.onHealth(hp, downed);
    const anim = this.player?.character?.animator;
    if (downed && !was) {
      void anim?.hold('knocked_out');
    } else if (!downed && was) {
      anim?.stop();
    }
  }

  /**
   * What the player can use, as interaction sources: getting into the nearest free car (or out
   * of the one they drive), and the city's points (the info kiosk opens the guide).
   */
  private addInteractions() {
    this.interactions.add((reach) => {
      if (this.chair)
        return {
          key: 'stand',
          label: 'Get up',
          icon: 'sit',
          distance: 0,
          run: () => this.standUp(),
        };
      return reach.driving ? null : this.seatNear(reach.x, reach.z);
    });
    this.interactions.add((reach) => {
      const v = this.vehicles;
      if (!v) return null;
      if (this.ride)
        return {
          key: 'exit',
          label: 'Get out',
          icon: 'exit',
          distance: 0,
          run: () => this.net.send({ type: 'exit_vehicle' }),
        };
      if (reach.driving)
        return { key: 'exit', label: 'Exit', icon: 'exit', distance: 0, run: () => this.exitCar() };
      const at = new THREE.Vector3(reach.x, reach.y, reach.z);
      // Not other players' own cars (their names are on them; only the owner may drive).
      const mine = `${this.session.name}'s car`;
      const car = v.nearestFree(
        at,
        VEHICLE_ENTER_RADIUS - 0.5,
        (c) => !c.remote?.name || c.remote.name === mine,
      );
      const driven = v.nearestDriven(at, VEHICLE_ENTER_RADIUS - 0.5, this.net.you);
      const ride: Interaction | null = driven && {
        key: `ride:${driven.id}`,
        label: 'Ride along',
        icon: 'car',
        at: { x: driven.pos.x, y: driven.pos.y + 1.7, z: driven.pos.z },
        distance: Math.hypot(driven.pos.x - reach.x, driven.pos.z - reach.z),
        run: () => this.net.send({ type: 'act', what: ACT.RIDE, arg: driven.id }),
      };
      if (!car) return ride;
      // Getting in needs the car clips: fetched now, while the player walks up.
      this.player?.character?.animator?.preloadCar();
      const enter: Interaction = {
        key: `car:${car.id}`,
        label: 'Enter car',
        icon: 'car',
        at: { x: car.pos.x, y: car.pos.y + 1.7, z: car.pos.z },
        distance: Math.hypot(car.pos.x - reach.x, car.pos.z - reach.z),
        run: () => this.enterCar(car.id),
      };
      return ride ? [enter, ride] : enter;
    });
    // A medic on duty beside someone down: hold to revive them (the server checks it all).
    this.interactions.add((reach) => {
      if (reach.driving || this.duty !== 'medical') return null;
      let best: { id: number; d: number; pos: THREE.Vector3 } | null = null;
      for (const b of this.remote.bodies.values()) {
        if (b.kind !== ENTITY_KIND.PLAYER || modeOf(b.state) !== MODE.DOWNED) continue;
        const d = Math.hypot(b.pos.x - reach.x, b.pos.z - reach.z);
        if (d < 2.5 && (!best || d < best.d)) best = { id: b.id, d, pos: b.pos };
      }
      if (!best) return null;
      const target = best.id;
      return {
        key: `revive:${target}`,
        label: 'Revive',
        icon: 'talk',
        at: { x: best.pos.x, y: best.pos.y + 1.2, z: best.pos.z },
        distance: best.d,
        holdMs: 2500,
        run: () => this.net.send({ type: 'revive', target }),
      };
    });
    // Jobs: what the shift allows now, or the offer to start one at a depot or office.
    this.interactions.add((reach) => {
      if (reach.driving) return null;
      const near = (i: number) => {
        const p = this.layout.points[i];
        if (!p) return null;
        const distance = Math.hypot(p.x - reach.x, p.z - reach.z);
        return distance <= p.radius ? { p, distance } : null;
      };
      const offers: Interaction[] = [];
      // Police staff: the elevator between the Station and its garage, on a job or not.
      if (this.memberOf === 'police') {
        this.liftPoints ??= this.layout.points.flatMap((p, i) => (p.kind === 'lift' ? [i] : []));
        for (const i of this.liftPoints) {
          const n = near(i);
          if (!n) continue;
          const down = interiorAt(n.p.x, n.p.z)?.id === 'police';
          offers.push({
            key: `lift:${i}`,
            label: down ? 'Elevator to the garage (floor 0)' : 'Elevator to the Station (floor 1)',
            icon: 'door',
            at: { x: n.p.x, y: 2.2, z: n.p.z },
            distance: n.distance,
            run: () => this.useDoor(i),
          });
        }
      }
      // A medic on duty at the Hospital's door: their ambulance (police use the garage).
      const door =
        this.duty === 'medical'
          ? this.layout.points.find((q) => q.kind === 'entrance' && q.service === 'hospital')
          : undefined;
      if (door && Math.hypot(door.x - reach.x, door.z - reach.z) < 8)
        offers.push({
          key: 'service-car',
          label: 'Get your ambulance',
          icon: 'car',
          at: { x: door.x, y: this.groundAt(door.x, door.z) + 2.4, z: door.z },
          distance: Math.hypot(door.x - reach.x, door.z - reach.z) + 1,
          run: () => this.command('/vehicle'),
        });
      if (this.job) {
        for (const a of this.job.actions) {
          const n = near(a.point);
          if (!n) continue;
          offers.push({
            key: `job:${a.point}:${a.label}`,
            label: a.label,
            icon: a.icon,
            at: { x: n.p.x, y: this.groundAt(n.p.x, n.p.z) + 2.2, z: n.p.z },
            distance: n.distance,
            holdMs: a.holdMs,
            run: () => (a.timing ? this.onTiming(a.point) : this.jobUse(a.point)),
          });
        }
        return offers;
      }
      this.layout.points.forEach((p, i) => {
        if (
          p.kind !== 'locker' &&
          p.kind !== 'counter' &&
          p.kind !== 'computer' &&
          p.kind !== 'till' &&
          p.kind !== 'join'
        )
          return;
        const n = near(i);
        if (!n) return;
        const kind = p.kind;
        const joins = factionOfBuilding(p.service);
        // A gang's own members walk straight in.
        if (kind === 'join' && joins && this.memberOf === joins && INTERIORS[p.service!].members)
          return;
        offers.push({
          key: `${kind}:${i}`,
          label:
            kind === 'locker'
              ? this.duty
                ? 'Go off duty'
                : 'Go on duty'
              : kind === 'counter'
                ? 'Counter'
                : kind === 'till'
                  ? 'Shop and jobs'
                  : kind === 'join'
                    ? INTERIORS[p.service!].members
                      ? 'Members only: how to join'
                      : 'How to join'
                    : 'Applications',
          icon: kind === 'counter' || kind === 'till' || kind === 'join' ? 'talk' : 'door',
          at: { x: p.x, y: (interiorAt(p.x, p.z) ? 0 : this.groundAt(p.x, p.z)) + 2.2, z: p.z },
          distance: n.distance,
          run: () => {
            if (kind === 'locker') {
              if (this.net.connected) this.net.send({ type: 'act', what: ACT.LOCKER, arg: i });
            } else if (kind === 'counter') this.onCounter();
            else if (kind === 'till') this.onTill();
            else if (kind === 'join') {
              if (joins) this.onJoin(joins);
            } else this.onComputer(p.service ?? 'police');
          },
        });
      });
      // A car park: pick one of your cars; the dealership: buy one (the markers open them by
      // themselves too).
      this.layout.points.forEach((p, i) => {
        if (p.kind === 'gunstore' || p.kind === 'black_market') {
          const n = near(i);
          if (n)
            offers.push({
              key: `${p.kind}:${i}`,
              label: p.kind === 'gunstore' ? 'Gun Store' : 'Talk',
              icon: p.kind === 'gunstore' ? 'door' : 'talk',
              at: { x: p.x, y: this.groundAt(p.x, p.z) + 2.2, z: p.z },
              distance: n.distance,
              run: () => this.onGunStore(i),
            });
          return;
        }
        if (p.kind !== 'parking' && p.kind !== 'dealer') return;
        const n = near(i);
        if (!n) return;
        const dealer = p.kind === 'dealer';
        offers.push({
          key: `${p.kind}:${i}`,
          label: dealer ? 'Buy a car' : 'Your cars',
          icon: 'car',
          at: { x: p.x, y: this.groundAt(p.x, p.z) + 2.4, z: p.z },
          distance: n.distance,
          run: () => (dealer ? this.onDealer(i) : this.onParking(i)),
        });
      });
      this.layout.points.forEach((p, i) => {
        const offer = JOB_OFFERS[p.kind];
        const n = offer && near(i);
        if (!offer || !n) return;
        if (offer.job === 'patrol' && this.duty !== 'police') return;
        offers.push({
          key: `offer:${i}`,
          label: offer.label,
          icon: 'job',
          at: { x: p.x, y: (interiorAt(p.x, p.z) ? 0 : this.groundAt(p.x, p.z)) + 2.4, z: p.z },
          distance: n.distance,
          run: () =>
            this.net.connected && this.net.send({ type: 'job', op: JOB_OP.START, point: i }),
        });
      });
      return offers;
    });
    this.layout.points.forEach((p, i) => {
      if (p.kind !== 'info') return;
      this.interactions.add((reach) => {
        const distance = Math.hypot(p.x - reach.x, p.z - reach.z);
        if (reach.driving || distance > p.radius) return null;
        return {
          key: `point:${i}`,
          label: 'City guide',
          icon: 'info',
          // Over the kiosk's lamp (the point is where the player stands, in front of it).
          at: { x: p.x - Math.sin(p.yaw) * 1.2, y: 2.9, z: p.z - Math.cos(p.yaw) * 1.2 },
          distance,
          run: () => {
            this.note('guide');
            this.onGuide();
          },
        };
      });
    });
  }

  /** Dev: a sample job view (?job=courier|mining). */
  private demoJob(kind: string) {
    const pts = this.layout.points;
    const door = pts.findIndex((p) => p.kind === 'door' && Math.hypot(p.x + 60, p.z) < 400);
    const ore = pts.findIndex((p) => p.kind === 'ore');
    const d = pts[door];
    const view: JobView =
      kind === 'mining'
        ? {
            job: 'mining',
            title: 'Mining · Granite Ridge Quarry',
            step: 'Mine ore at the faces in the pit',
            objective: null,
            actions: pts
              .map((p, i) => ({ p, i }))
              .filter(({ p }) => p.kind === 'ore')
              .map(({ i }) => ({
                point: i,
                label: 'Mine copper',
                icon: 'job' as const,
                timing: true,
              })),
            cargo: { label: 'Ore', count: 2, max: 6 },
            progress: { done: 2, total: 4, label: 'Strikes' },
            endsAt: this.serverNow() + 14 * 60_000,
            earned: { cents: 0, xp: 0 },
          }
        : {
            job: 'courier',
            title: 'Courier · Courier Depot',
            step: `Deliver to ${d?.name ?? '?'}`,
            objective: d ? { x: d.x, z: d.z, label: d.name ?? 'Delivery' } : null,
            actions: [{ point: door, label: 'Deliver package', icon: 'door', holdMs: 900 }],
            cargo: { label: 'Packages', count: 3 },
            progress: { done: 1, total: 4, label: 'Deliveries' },
            endsAt: this.serverNow() + 21 * 60_000,
            earned: { cents: 6_500, xp: 22 },
          };
    this.onJob(JSON.stringify(view));
    this.onReward({ cents: 6_500, xp: 22, totalXp: 0, reason: 'Delivery · 154 6th St' });
    // Once the HUD has its swing ready (it mounts after the world loads).
    const noSwing = this.onTiming;
    const open = () =>
      this.onTiming === noSwing ? window.setTimeout(open, 500) : this.onTiming(ore);
    if (kind === 'mining') open();
  }

  /** Uses a point in the current job (a delivery, a sale, a mining strike). */
  jobUse(point: number): void {
    if (this.net.connected) this.net.send({ type: 'job', op: JOB_OP.USE, point });
  }

  /** A mining strike that landed: the swing, then the server counts it. */
  strike(point: number): void {
    this.player?.character?.animator?.punch();
    this.jobUse(point);
  }

  quitJob(): void {
    if (this.net.connected) this.net.send({ type: 'job', op: JOB_OP.QUIT, point: 0 });
  }

  private onJob(state: string) {
    let view: JobView | null;
    try {
      view = state ? (JSON.parse(state) as JobView) : null;
    } catch {
      view = null;
    }
    this.job = view;
    if (view?.objective) this.waypoints.set({ ...view.objective, by: 'job' });
    else this.waypoints.clear('job');
  }

  private onReward(m: { cents: number; xp: number; totalXp: number; reason: string }) {
    const before = this.hud.xp === null ? null : levelOf(this.hud.xp).level;
    if (this.hud.money !== null) this.hud.money += m.cents;
    if (m.totalXp > 0) this.hud.xp = m.totalXp;
    const after = this.hud.xp === null ? null : levelOf(this.hud.xp).level;
    this.rewards.push({
      key: ++this.rewardSeq,
      cents: m.cents,
      xp: m.xp,
      reason: m.reason,
      levelUp: before !== null && after !== null && after > before ? after : null,
      at: performance.now(),
    });
    if (this.rewards.length > 5) this.rewards.shift();
    this.sounds?.reward();
  }

  /** Ground (or a bridge or the pier) under (x, z); a room's floor is at 0. */
  private groundAt(x: number, z: number): number {
    return interiorAt(x, z) ? 0 : heightRange(this.layout, x, z).top;
  }

  /** Stepping onto an entrance or exit marker goes through it, once per step. */
  private checkDoors(x: number, z: number) {
    const was = this.layout.points[this.doorInside];
    if (was) {
      if (Math.hypot(was.x - x, was.z - z) > was.radius + DOOR.rearm) this.doorInside = -1;
      return;
    }
    if (performance.now() < this.doorRestUntil) return;
    this.doorPoints ??= this.layout.points.flatMap((p, i) =>
      p.kind === 'entrance' || p.kind === 'exit' ? [i] : [],
    );
    for (const i of this.doorPoints) {
      const p = this.layout.points[i] as (typeof this.layout.points)[number];
      if (Math.hypot(p.x - x, p.z - z) > p.radius) continue;
      // The way out takes walking at the door (always in a room's south wall): crossing the
      // lobby past it, or turning round beside it, isn't leaving.
      if (p.kind === 'exit' && (this.player?.velocity.z ?? 0) > -0.5) continue;
      this.doorInside = i;
      this.doorRestUntil = performance.now() + DOOR.restMs;
      this.useDoor(i);
      return;
    }
  }

  private useDoor(point: number) {
    const door = this.layout.points[point];
    if (!door?.service) return;
    if (door.kind === 'lift') {
      this.fadeUntil = performance.now() + DOOR_FADE_MS;
      if (this.net.connected) return this.net.send({ type: 'act', what: ACT.DOOR, arg: point });
      const to = this.layout.points.find((q) => q.kind === 'lift' && q !== door);
      if (to) {
        this.player?.place(to.x, 0.2, to.z, to.yaw);
        this.follow?.face(to.yaw);
      }
      return;
    }
    const room = INTERIORS[door.service];
    if (this.net.connected) {
      if (room.members && door.kind === 'entrance' && this.memberOf !== room.id) return;
      this.fadeUntil = performance.now() + DOOR_FADE_MS;
      this.net.send({ type: 'act', what: ACT.DOOR, arg: point });
    } else if (door.kind === 'entrance') {
      // Offline: no server to ask.
      this.fadeUntil = performance.now() + DOOR_FADE_MS;
      this.player?.place(room.spawn.x, 0.2, room.spawn.z, room.spawn.yaw);
      this.follow?.face(room.spawn.yaw);
    } else {
      const out = this.layout.points.find(
        (q) => q.kind === 'entrance' && q.service === door.service,
      );
      if (!out) return;
      this.fadeUntil = performance.now() + DOOR_FADE_MS;
      const x = out.x + Math.sin(out.yaw) * DOOR.stepOut;
      const z = out.z + Math.cos(out.yaw) * DOOR.stepOut;
      this.player?.place(x, this.groundAt(x, z) + 0.2, z, out.yaw);
      this.follow?.face(out.yaw);
    }
  }

  /** Shows the room we're in, or the city. */
  private updateIndoors(x: number, z: number) {
    const room = interiorAt(x, z);
    const id = room?.id ?? null;
    if (id === this.indoors) return;
    this.indoors = id;
    this.interiors.show(id);
    if (room?.clerk) void this.addClerk(room.id, room.clerk);
    this.city.group.visible = !room;
    this.hud.indoors = room?.name ?? null;
    this.doorInside = this.layout.points.findIndex(
      (p) => (p.kind === 'entrance' || p.kind === 'exit') && Math.hypot(p.x - x, p.z - z) < 4,
    );
  }

  /** Server time now (ms), for job timers. */
  serverNow(): number {
    return this.net.serverNow();
  }

  private exitCar() {
    const car = this.vehicles?.driven;
    if (!car) return;
    const speed = Math.abs(car.speed);
    if (this.net.connected) this.net.send({ type: 'exit_vehicle' });
    this.leaveCar(true);
    // Too fast to step out: down on the road (the server takes the health).
    if (speed >= FALL.minSpeed) {
      this.fallUntil = performance.now() + FALL.downMs;
      void this.player?.character?.animator?.hold('knocked_out', FALL.fallRate);
    }
  }

  /** Whether we're on the ground after falling from a car: down, then getting up. */
  private updateFall(): boolean {
    if (this.fallUntil === 0) return false;
    const now = performance.now();
    if (now < this.fallUntil) return true;
    if (this.risingUntil === 0) {
      this.risingUntil = now + FALL.getUpMs;
      this.player?.character?.animator?.getUp(FALL.getUpMs / 1000);
    }
    if (now < this.risingUntil) return true;
    this.fallUntil = 0;
    this.risingUntil = 0;
    return false;
  }

  /** Down: wake in a hospital bed now. */
  faint(): void {
    if (this.net.connected) this.net.send({ type: 'act', what: ACT.FAINT, arg: 0 });
  }

  /** Down: call EMS. */
  callEms(): void {
    if (this.net.connected) this.net.send({ type: 'act', what: ACT.CALL_EMS, arg: 0 });
  }

  /** In a hospital bed: up now, with the health so far. */
  getUp(): void {
    if (this.net.connected) this.net.send({ type: 'act', what: ACT.GET_UP, arg: 0 });
  }

  /** Our own uniform: swapped in when the faction or duty changes. */
  private dress(faction: string | null, duty: string | null, rank: number) {
    const key = `${faction}:${duty !== null}:${rank}`;
    if (key === this.wearing) return;
    const appearance = decodeAppearance(this.session.look ?? encodeAppearance(DEFAULT_APPEARANCE));
    const member = isFactionId(faction) ? faction : null;
    const real = uniformOutfit(member, rank, duty !== null, appearance.body);
    const dressed = real ? null : uniformOf(member, duty !== null);
    // The first word from the server, nothing to change into: stay as we are.
    const first = this.wearing === null && !dressed && !real;
    this.wearing = key;
    const player = this.player;
    const combat = this.combat;
    if (first || !player || !combat) return;
    const look: Look = { ...appearance, uniform: dressed, dress: real };
    void Character.load(look, 0, 0, decodeGear(this.session.gear ?? 0)).then((next) => {
      if (this.wearing !== key) return;
      const old = player.character;
      if (old) this.scene.remove(old.root);
      for (const gun of combat.gunMeshes) next.holdInRightHand(gun);
      this.scene.add(next.root);
      player.character = next;
    });
  }

  /** On a chair (the server's word), or up from it: drawn there, the body out of the world. */
  private setChair(seat: Seat | null) {
    const player = this.player;
    if (!player) return;
    const anim = player.character?.animator;
    if (seat && !this.chair) {
      player.setEnabled(false);
      void anim?.sit();
    } else if (!seat && this.chair) {
      player.setEnabled(true);
      void anim?.stand();
    }
    this.chair = seat;
    this.standingUp = false;
  }

  /** The nearest free seat in reach of (x, z), as something to do. */
  private seatNear(x: number, z: number): Interaction | null {
    const seats = interiorAt(x, z)?.seats;
    if (!seats) return null;
    let best: Interaction | null = null;
    seats.forEach((seat, i) => {
      const distance = Math.hypot(seat.x - x, seat.z - z);
      if (distance > SEAT_REACH_M || (best && distance >= best.distance)) return;
      for (const b of this.remote.bodies.values())
        if (
          modeOf(b.state) === MODE.SITTING &&
          Math.hypot(b.pos.x - seat.x, b.pos.z - seat.z) < 0.3
        )
          return;
      best = {
        key: `seat:${i}`,
        label: 'Sit',
        icon: 'sit',
        at: { x: seat.x, y: SEAT_Y + 0.5, z: seat.z },
        distance,
        run: () => {
          if (this.net.connected) this.net.send({ type: 'act', what: ACT.SIT, arg: i });
          else {
            this.player?.place(seat.x, 0.2, seat.z, seat.yaw);
            this.setChair(seat);
          }
        },
      };
    });
    return best;
  }

  /** Up from the chair: once, however long the stick is held. */
  private standUp() {
    if (!this.chair || this.standingUp) return;
    this.standingUp = true;
    if (this.net.connected) this.net.send({ type: 'act', what: ACT.STAND, arg: 0 });
    else this.setChair(null);
  }

  /** In a hospital bed (the server's word), or out of it. */
  private setBed(bed: Bed | null) {
    const player = this.player;
    if (!player) return;
    const anim = player.character?.animator;
    if (bed && !this.bed) {
      player.setEnabled(false);
      void anim?.lie('knocked_out');
    } else if (!bed && this.bed) {
      player.setEnabled(true);
      anim?.stop();
    }
    this.bed = bed;
    this.hud.inBed = bed !== null;
  }

  private enterCar(carId: number) {
    if (this.net.connected) {
      if (this.seatPending) return;
      this.seatPending = true;
      this.net.send({ type: 'enter_vehicle', vehicle: carId });
    } else {
      this.takeWheel(carId);
    }
  }

  private takeWheel(vehicleId: number) {
    const v = this.vehicles;
    if (!v || !this.player || !this.follow) return;
    const car = v.startDriving(vehicleId);
    if (!car) return;
    this.player.setEnabled(false);
    this.follow.inCar = true;
    this.follow.face(car.yaw);
    this.hud.driving = true;
    this.applyCondition();
    // Our character gets in at the driver's door and stays at the wheel (drawn each frame).
    this.leftCar = null;
    void this.player.character?.animator?.getIn();
  }

  /** Riding in someone else's car: which, and which seat. */
  private ride: { vehicle: number; seat: number } | null = null;

  /** In beside a driver, or out again (the server's correction places us beside the car). */
  private setRide(ride: { vehicle: number; seat: number } | null) {
    const player = this.player;
    if (!player || !this.follow) return;
    const anim = player.character?.animator;
    if (ride && !this.ride) {
      player.setEnabled(false);
      this.follow.inCar = true;
      void anim?.ride();
    } else if (!ride && this.ride) {
      player.setEnabled(true);
      this.follow.inCar = false;
      anim?.stop();
    }
    this.ride = ride;
    this.hud.passenger = ride !== null;
  }

  /** The car we just got out of, while our character climbs out of it. */
  private leftCar: SeatCar | null = null;

  /** Back on foot beside the driver's door (the server's correction refines it online). */
  private leaveCar(placeAtDoor: boolean) {
    const v = this.vehicles;
    const player = this.player;
    if (!v || !player || !this.follow) return;
    const car = v.stopDriving();
    const anim = player.character?.animator;
    if (car && anim) {
      // Out of the driver's door, from the seat (walking off cuts it short).
      this.leftCar = { pos: car.pos.clone(), yaw: car.yaw, id: car.model.spec.id };
      void anim.getOut();
    } else anim?.stop();
    if (car && placeAtDoor) {
      const left = { x: Math.cos(car.yaw), z: -Math.sin(car.yaw) };
      player.place(
        car.pos.x + left.x * 1.8,
        Math.max(car.pos.y, 0),
        car.pos.z + left.z * 1.8,
        car.yaw,
      );
    }
    player.setEnabled(true);
    this.follow.inCar = false;
    this.hud.driving = false;
    this.hud.speedKmh = 0;
  }

  /** Re-anchors the game clock (e.g. from the server's welcome). */
  /** Anchors from the server are on its timeline (NetClient.serverNow), not the wall clock. */
  setClock(anchor: ClockAnchor): void {
    this.clock = anchor;
    this.clockOnServer = true;
  }

  private gameMinutes(): number {
    if (this.clock.rate === 0) return this.clock.gameMinutes;
    return gameMinutesAt(this.clock, this.clockOnServer ? this.net.serverNow() : Date.now());
  }

  start(): void {
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  dispose(): void {
    this.disposed = true;
    this.sounds?.dispose();
    window.clearTimeout(this.reconnectTimer);
    void this.voice.disconnect();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.fly?.dispose();
    this.input.dispose();
    this.net.close();
    this.renderer.dispose();
  }

  private resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(now: number) {
    // A little under the limit, so a frame that's on time isn't put off to the next refresh.
    if (now - this.lastFrame < this.quality.minFrameMs - 3) return;
    const started = performance.now();
    if (now >= this.adaptFrom && !this.quality.pinned) this.frameGaps.push(now - this.lastFrame);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.frameNo += 1;
    const minutes = this.gameMinutes();
    const hour = hourOfDay(minutes);
    this.hud.clock = formatClock(minutes);
    this.hud.hour = hour;

    this.input.update();
    let focus: THREE.Vector3;
    if (this.fly) {
      this.fly.update();
      focus = this.fly.target;
    } else if (this.player && this.physics && this.follow) {
      this.simulate(dt, this.player, this.physics, this.follow);
      // In a car the player's body waits where they got in: the car is where things happen
      // (the sky, the shadows). Left on the body, driving off a few hundred metres took the
      // camera out of the sky box and half the sky went black.
      focus = this.vehicles?.driven?.position ?? this.player.position;
    } else {
      focus = this.camera.position;
    }

    // Indoors the light is the room's: the sun stands high whatever the hour, so people show.
    const state = this.sky.update(
      this.indoors ? INDOOR_HOUR : hour,
      focus,
      this.renderer,
      now,
      this.camera.position,
    );
    this.night = state.night;
    worldUniforms.uNight.value = state.night;
    this.city.update(state.night, this.camera.position);
    this.vehicles?.update(dt, state.night, this.camera);
    if (!this.fly) {
      this.tutorial?.update();
      const at = this.whereabouts();
      if (at) this.waypoints.update(at.x, at.z, now, dt, !this.vehicles?.driven);
    }
    if (this.frameNo % this.quality.shadowEvery === 0) this.sky.refreshShadows();

    if (this.mapCamera) {
      // Dev (?mapshot): the whole island from straight above, without haze.
      this.scene.fog = null;
      this.renderer.render(this.scene, this.mapCamera);
    } else if (this.drawing) this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
    this.measure(started);
  }

  /** Fixed-step physics for the player on foot or the car they drive, then camera follow. */
  private simulate(dt: number, player: LocalPlayer, physics: Physics, follow: FollowCamera) {
    const combat = this.combat;
    const falling = this.updateFall();
    const downed = (combat?.downed ?? false) || falling;
    {
      const inCar = this.vehicles?.driven ?? null;
      const at = inCar ? inCar.position : player.position;
      const pressed = this.input.consume('KeyE', 'KeyF', 'interact');
      const held = this.input.held('KeyE', 'KeyF', 'interact');
      const reach = {
        x: at.x,
        y: at.y,
        z: at.z,
        yaw: player.yaw,
        driving: !!inCar || this.ride !== null,
      };
      if (downed) this.interactions.current = null;
      else this.interactions.update(reach, pressed, held, performance.now());
      if (!inCar && !downed && !this.chair && !this.ride) {
        this.checkParking(at.x, at.z);
        this.checkDoors(at.x, at.z);
      }
      this.updateIndoors(at.x, at.z);
      const now = this.interactions.current;
      this.hud.action = now?.label ?? null;
      this.hud.actionIcon = now?.icon ?? null;
      this.hud.actionHeld = this.interactions.progress;
    }
    // The car after the prompt ran: getting out just now freed the car's physics body. Read
    // before it, the rest of this frame stepped the freed body; Rapier panicked, every later
    // call failed, and the picture froze on the inside of the car while the HUD went on foot.
    const car = this.vehicles?.driven ?? null;
    // Q (or the touch button) takes the next weapon we own in hand, back to bare hands after
    // the last; the server says yes (protocol `arms`). R reloads. Bare hands punch.
    if (combat && !car && !downed && this.input.consume('KeyQ', 'weapon')) {
      const next = combat.nextWeapon();
      if (this.net.connected) this.net.send({ type: 'equip', weapon: next });
      else combat.show(next);
    }
    const armedNow = (combat?.weapon ?? WEAPON.NONE) !== WEAPON.NONE;
    if (combat && !car && this.input.consume('KeyR', 'reload') && this.net.connected) {
      this.net.send({ type: 'reload' });
      if (armedNow) this.sounds?.gun('reload');
    }
    if (
      combat &&
      !car &&
      !downed &&
      combat.weapon === WEAPON.NONE &&
      (this.input.consume('Mouse0') || this.input.consume('punch')) &&
      combat.punch(player.position, player.yaw)
    )
      player.character?.animator?.punch();
    const armed = !car && !downed && (combat?.weapon ?? WEAPON.NONE) !== WEAPON.NONE;
    // Fire raises the aim too (touch has no other way) and it stays a moment after the last
    // shot, so the view doesn't pump in and out with every tap.
    const firing = armed && this.input.held('Mouse0', 'fire');
    if (firing) this.aimHoldUntil = performance.now() + AIM_HOLD_MS;
    const aiming =
      armed &&
      (firing || this.input.held('Mouse2', 'aim') || performance.now() < this.aimHoldUntil);
    const anim = player.character?.animator;
    const rifle = armed && combat?.weapon === WEAPON.ASSAULT_RIFLE;
    anim?.setStance(armed ? (rifle ? 'rifle' : 'pistol') : 'unarmed');
    anim?.setAiming(aiming);
    // The spine follows the crosshair up and down while aiming.
    if (anim && aiming) {
      this.camera.getWorldDirection(AIM_DIR);
      anim.pitch = Math.asin(THREE.MathUtils.clamp(AIM_DIR.y, -1, 1));
    }
    // Holding the mic: their character talks with their hands too, for them and for others.
    const talking = !downed && this.input.held('KeyV', 'mic');
    this.stanceFlags =
      (armed ? FLAG.ARMED : 0) |
      (rifle ? FLAG.RIFLE : 0) |
      (aiming ? FLAG.AIM : 0) |
      (talking ? FLAG.TALKING : 0);
    anim?.setTalking(talking);
    follow.aiming = aiming;
    player.faceYaw = armed ? follow.yaw : null;
    // Downed bodies don't move (the server ignores them too).
    if (downed) {
      this.input.move.x = 0;
      this.input.move.y = 0;
    }
    // On a chair, pushing the stick gets up; the body itself goes nowhere until the server says.
    if (this.chair) {
      if (Math.hypot(this.input.move.x, this.input.move.y) > 0.3) this.standUp();
      this.input.move.x = 0;
      this.input.move.y = 0;
    }
    // Collision streaming: only the city around us takes part in physics (physics.ts).
    const here = car ? car.position : player.position;
    physics.focus(here.x, here.z);
    let jump = !car && !downed && !this.chair && this.input.consume('Space', 'jump');
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < 5) {
      if (car) car.step(this.input.drive);
      else player.step(this.input, follow.yaw, jump);
      physics.step();
      jump = false;
      this.accumulator -= PHYSICS_DT;
      steps += 1;
    }
    if (steps === 5) this.accumulator = 0;
    follow.zoomBy(this.input.zoom);
    const riding = this.ride ? this.vehicles?.cars.get(this.ride.vehicle) : null;
    if (car) {
      car.sync(this.accumulator / PHYSICS_DT);
      // Only drift behind the car while it is really moving forward.
      const behind = car.speed > 3 ? car.yaw : undefined;
      follow.update(dt, this.input.look, car.position, car.chassis, behind);
      this.hud.speedKmh = Math.round(Math.abs(car.speed) * 3.6);
      this.hud.gear =
        car.speed < -0.5 ? 'R' : car.speed > 0.5 || this.input.drive.throttle > 0 ? 'D' : 'N';
      // Our character at the wheel, tilting with the car.
      const me = player.character;
      if (me) {
        me.root.visible = true;
        const seat = me.animator?.seat === 'enter' ? 'enter' : 'drive';
        const at = { pos: car.position, yaw: car.yaw, quat: car.quaternion, id: car.spec.id };
        seatCharacter(me.root, at, seat, me.animator?.hipsRestY ?? 0.9);
        me.update(dt, 0);
      }
    } else if (riding) {
      // The driver's car carries us: the body waits, and everything else follows the car.
      player.position.copy(riding.pos);
      follow.update(dt, this.input.look, riding.pos);
      const me = player.character;
      if (me) {
        me.root.visible = true;
        seatCharacter(
          me.root,
          { pos: riding.pos, yaw: riding.yaw, id: riding.model.spec.id },
          'drive',
          me.animator?.hipsRestY ?? 0.9,
          this.ride?.seat ?? 1,
        );
        me.update(dt, 0);
      }
    } else {
      player.sync(dt, this.accumulator / PHYSICS_DT);
      const bed = this.bed;
      const chair = this.chair;
      if (bed) BED_POS.set(bed.x, BED_Y, bed.z);
      if (chair) SEAT_POS.set(chair.x, 0, chair.z);
      follow.update(
        dt,
        this.input.look,
        bed ? BED_POS : chair ? SEAT_POS : player.position,
        player.body,
      );
      // Lying in a hospital bed: drawn there, the body out of the world.
      const lying = player.character;
      if (bed && lying) {
        lying.root.visible = true;
        lying.root.position.copy(BED_POS);
        lying.root.rotation.set(0, bed.yaw + BED_TURN, 0);
        lying.update(dt, 0);
      }
      const sat = player.character;
      if (chair && sat) {
        sat.root.visible = true;
        sat.root.position.copy(SEAT_POS);
        sat.root.position.y += FOOT_LIFT;
        sat.root.rotation.set(0, chair.yaw, 0);
        sat.update(dt, 0);
      }
      // Climbing out of the car we left, until we walk off.
      const me = player.character;
      if (this.leftCar && me?.animator?.seat === 'exit')
        seatCharacter(me.root, this.leftCar, 'exit', me.animator.hipsRestY);
      else this.leftCar = null;
    }
    if (combat) {
      // Held, it keeps firing at the gun's own rate (combat.fire); a tap between frames counts.
      const pulled = this.input.consume('Mouse0', 'fire');
      if (armed && (pulled || firing)) {
        // On touch, a little help onto players near the crosshair (combat.ts).
        const assist = isTouchDevice()
          ? [...this.remote.bodies.values()]
              .filter((b) => b.kind === ENTITY_KIND.PLAYER && modeOf(b.state) !== MODE.DOWNED)
              .map((b) => b.pos.clone().add(CHEST))
          : [];
        if (combat.fire(this.camera, player.position, player.body, assist)) {
          anim?.fire();
          this.sounds?.shot(combat.weapon);
        } else if (combat.emptied() && this.net.connected) {
          this.net.send({ type: 'reload' });
          this.sounds?.gun('reload');
        } else if (pulled && combat.ammo()?.mag === 0) this.sounds?.gun('dry');
      }
      this.hud.aimOnPerson =
        armed && combat.onPerson(this.camera, player.body, this.playersInView());
      combat.update();
      this.hud.armed = armed;
      this.hud.aiming = aiming;
      this.hud.ammo = armed ? combat.ammo() : null;
      this.hud.ownsWeapon = (combat.arms?.weapons.length ?? 0) > 0;
      this.hud.hp = combat.hp;
      this.hud.fading = performance.now() < this.fadeUntil;
      // Only at no health: falling from a car puts you on the floor, but you're not down.
      this.hud.downed = combat.downed;
      this.hud.hitAt = combat.lastHitAt;
      this.hud.hitHead = combat.lastHitHead;
      this.hud.hurtAt = combat.lastHurtAt;
      this.hud.respawnIn = combat.downed
        ? Math.max(0, (this.downedEnd - performance.now()) / 1000)
        : 0;
      if (downed) player.mode = MODE.IDLE;
    }
    this.sendState(dt, player);
    this.remote.update(dt, this.net.serverNow(), this.camera.position);
    // Luz idles, when she's near enough to see.
    if (this.luz && this.luz.root.position.distanceTo(this.camera.position) < 80)
      this.luz.update(dt, 0);
    if (this.clerk && this.indoors === 'market') this.clerk.update(dt, 0);
    // Blocked players who've come into view since: mute them too (a few times a second).
    if (this.blocked.size > 0 && this.frameNo % 15 === 0) this.applyBlocks();
    this.hud.ping = Math.round(this.net.rtt);
    this.hud.nearby = this.remote.bodies.size;
    // Push to talk: V held, or the touch mic toggle.
    this.voice.setTalking(talking);
    this.voice.update(player.position, (id) => this.remote.bodies.get(id)?.pos ?? null);
    this.hud.voice = this.voice.state;
    this.hud.talking = this.voice.talking;
    this.hud.hearing = this.voice.hearing;
    const vehicles = this.vehicles;
    const drive = this.input.drive;
    this.sounds?.update(dt, {
      listener: this.camera,
      walker: car ? null : player,
      driving: car && {
        id: car.spec.id,
        top: car.spec.topSpeed,
        speed: car.speed,
        throttle: Math.max(0, drive.throttle),
        // Sideways speed: the velocity across the car's heading.
        slide: car.velocity.x * Math.cos(car.yaw) - car.velocity.z * Math.sin(car.yaw),
        braking: car.braking,
        handbrake: drive.handbrake,
        horn: drive.horn,
        running: car.power > 0,
      },
      cars: vehicles
        ? [...vehicles.cars.values()]
            .filter((c) => c.id !== vehicles.drivenId)
            .map((c) => ({
              id: c.id,
              model: { id: c.model.spec.id, top: c.model.spec.topSpeed },
              pos: c.pos,
              speed: c.speed,
              state: c.remote?.state ?? 0,
            }))
        : [],
      walkers: [...this.remote.bodies.values()]
        .filter((b) => b.kind === ENTITY_KIND.PLAYER)
        .map((b) => ({ id: b.id, pos: b.pos, mode: modeOf(b.state) })),
    });
  }

  private measure(started: number) {
    const info = this.renderer.info;
    this.stats.frameMs = this.stats.frameMs * 0.9 + (performance.now() - started) * 0.1;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.textures = info.memory.textures;
    this.stats.geometries = info.memory.geometries;
    this.fpsFrames += 1;
    const now = performance.now();
    if (now - this.fpsSince >= 500) {
      this.stats.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      this.stats.heapMB = mem ? mem.usedJSHeapSize / 1048576 : 0;
      if (!this.quality.pinned) this.adaptResolution(now);
    }
  }

  /**
   * Holds the frame rate by rendering fewer pixels when it can't keep up, and more again when
   * there's room (ResolutionGovernor), checked every two seconds of play. Every tier, not only
   * Auto: a phone set to Medium kept its full resolution at a few frames a second and couldn't be
   * walked, let alone driven.
   */
  private adaptResolution(now: number) {
    if (now - this.resolutionCheckedAt < 2000) return;
    this.resolutionCheckedAt = now;
    const scale = this.governor.check(this.frameGaps, now);
    this.frameGaps.length = 0;
    if (Math.abs(scale - this.resolutionScale) < 0.01) return;
    this.resolutionScale = scale;
    this.renderer.setPixelRatio(this.quality.pixelRatio * scale);
    this.stats.resolution = Math.round(scale * 100);
  }
}

/**
 * The world server is a newer version than this page (a deploy while the app was open, or
 * an installed app resumed from the background): load the new game. At most once in five
 * minutes, so a server deployed ahead of the page can't send it round in circles.
 */
function reloadForUpdate() {
  const KEY = 'fr33.reloadedForUpdate';
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 5 * 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return; // storage blocked: leave it to the player (the message says to reload)
  }
  location.reload();
}

/** A taxi ride as the screen shows it (hud Ride.tsx). */
export interface Ride {
  state: 'calling' | 'riding' | 'refused';
  to: string;
  seconds: number;
  cents: number;
  text: string;
}

/** Dev (?phone=bank without a login): a sample statement for screenshots. */
function demoStatement(): Statement {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    balance: 1_284_250,
    frozen: false,
    more: true,
    history: [
      { id: 9, at: ago(4), kind: 'payment', amount: -25_000, other: 'Maya Torres', note: 'tacos' },
      { id: 8, at: ago(38), kind: 'earn:jobs', amount: 42_500, other: null, note: null },
      {
        id: 7,
        at: ago(95),
        kind: 'payment',
        amount: 150_000,
        other: 'Jay Rivera',
        note: 'car rent',
      },
      { id: 6, at: ago(180), kind: 'spend:hospital', amount: -5_000, other: null, note: null },
      { id: 5, at: ago(2900), kind: 'earn:salary', amount: 20_000, other: null, note: null },
      { id: 1, at: ago(4000), kind: 'signup_bonus', amount: 500_000, other: null, note: null },
    ],
  };
}
