/**
 * The job framework (Phase 6, PRD §7.4): one system for eligibility, state, objective checks,
 * rewards, cooldowns, quitting, expiry, and resuming after a reconnect, while each job keeps its
 * own gameplay (courier.ts, mining.ts). A job is a definition with its own state; the player's
 * client only asks to use a city point (`job` messages), and the server checks it is in reach
 * of the player's accepted position, on foot when it must be, and that the job allows it now.
 * Rewards go through the API (money from the jobs faucet and XP together, keyed per step, so a
 * replay pays once); the state is saved to the API, so a shift survives a server restart.
 */
import { canReach, type InteractionPoint, type PointKind, type RoadGraph } from '@fr33world/city';
import { JOB_OP } from '@fr33world/protocol';
import { FAUCETS, type JobId, type JobView, levelOf } from '@fr33world/shared';

export type { JobAction, JobId, JobView } from '@fr33world/shared';

export interface JobPlayer {
  id: number;
  account: string | null;
  x: number;
  z: number;
  onFoot: boolean;
  downed: boolean;
  xp: number;
  /** Their faction (shared FactionId), for jobs only some may take (gang collections). */
  faction?: string | null;
}

export interface Pay {
  cents: number;
  xp: number;
  reason: string;
  /** Unique for this step of this shift. */
  key: string;
}

/** What a use did: the new state (null: the shift is over), a reward, a line to say. */
export interface Outcome<S> {
  state: S | null;
  pay?: Pay;
  say?: string;
  /** The work is done: the API releases the USDC held for it on chain (haul.ts). */
  settle?: boolean;
}

export interface JobContext {
  now: number;
  points: readonly InteractionPoint[];
  roads: RoadGraph;
  random: () => number;
  /** State shared by everyone doing this job (e.g. how much ore a face has left). */
  shared: Map<string, unknown>;
  /** This shift's id (part of every reward key). */
  shift: string;
}

export interface JobDef<S> {
  id: JobId;
  title: string;
  /** The kind of point that offers this job, and what its prompt says there. */
  offeredAt: PointKind;
  offer: string;
  minLevel?: number;
  /** After a shift ends, before another (ms). */
  cooldownMs: number;
  start(ctx: JobContext, p: JobPlayer, point: number): S | string;
  /** Using `point` during the shift: the outcome, or why not (shown to the player). */
  use(ctx: JobContext, s: S, p: JobPlayer, point: number): Outcome<S> | string;
  view(ctx: JobContext, s: S): JobView;
  /** Over by itself (too long, idle)? Then this is said. */
  expired?(ctx: JobContext, s: S): string | null;
  /** What keeps the shift going, for the warning before it ends ("mine or sell ore"). */
  keepAlive?: string;
  /** The pay for quitting partway, if any (e.g. none: deliveries are paid as they're made). */
  quit?(ctx: JobContext, s: S): Outcome<S>;
}

interface Active {
  def: JobDef<unknown>;
  state: unknown;
  shift: string;
  /** Pays in flight, so the next one waits its turn (rewards apply in order). */
  paying: Promise<void>;
  view: string;
  /** The end time a warning was last given for (so it's said once per deadline). */
  warnedFor: number;
}

export interface Saved {
  job: JobId;
  shift: string;
  state: unknown;
}

/** What the jobs need from the world. */
export interface JobHost {
  now(): number;
  /** A now() time on the server-time timeline clients count in (NetClient.serverNow). */
  serverTime(at: number): number;
  points: readonly InteractionPoint[];
  roads: RoadGraph;
  /** The player's job view ('' for none). */
  send(playerId: number, view: string): void;
  rewarded(
    playerId: number,
    r: { cents: number; xp: number; totalXp: number; reason: string },
  ): void;
  tell(playerId: number, text: string): void;
  /** Pays through the API; rejects when it can't. */
  reward(account: string, pay: Pay): Promise<{ cents: number; xp: number; totalXp: number }>;
  /** A USDC job finished: the API pays it from the money held on chain. */
  settle(account: string): Promise<void>;
  /** Resolves after `ms` (between tries of a pay the API couldn't take). */
  wait(ms: number): Promise<void>;
  save(account: string, saved: Saved | null): Promise<void>;
  load(account: string): Promise<Saved | null>;
  /** Local play without the API: players without a login may work (nothing is kept). */
  anonymousOk?: boolean;
}

/** How long before a shift ends by itself the player is warned (ms). */
const WARN_MS = 2 * 60_000;
/** A pay the API couldn't take is tried again after these waits (ms): about 8 minutes in all. */
const PAY_RETRY_MS = [5_000, 15_000, 60_000, 120_000, 300_000];
/** Cents as the player reads them: $1,500 or $840.50. */
const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Job messages a player may send per second (strikes come about one a second). */
const MIN_GAP_MS = 250;

export class Jobs {
  private readonly host: JobHost;
  private readonly defs: Map<JobId, JobDef<unknown>>;
  private readonly active = new Map<number, Active>();
  private readonly cooldowns = new Map<string, number>();
  private readonly lastAt = new Map<number, number>();
  private readonly shared = new Map<JobId, Map<string, unknown>>();
  private seq = 0;

  constructor(host: JobHost, defs: JobDef<unknown>[]) {
    this.host = host;
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }

  private ctx(def: JobDef<unknown>, shift: string): JobContext {
    let shared = this.shared.get(def.id);
    if (!shared) this.shared.set(def.id, (shared = new Map<string, unknown>()));
    return {
      now: this.host.now(),
      points: this.host.points,
      roads: this.host.roads,
      random: Math.random,
      shared,
      shift,
    };
  }

  /** The player's current job, if any (for tests and the world). */
  current(playerId: number): { job: JobId; state: unknown } | null {
    const a = this.active.get(playerId);
    return a ? { job: a.def.id, state: a.state } : null;
  }

  /** A `job` message from a player. */
  handle(p: JobPlayer, op: number, pointIndex: number): void {
    const now = this.host.now();
    if (now - (this.lastAt.get(p.id) ?? -Infinity) < MIN_GAP_MS) return;
    this.lastAt.set(p.id, now);
    const active = this.active.get(p.id);
    if (op === JOB_OP.QUIT) return this.end(p, active, 'quit');
    const point = this.host.points[pointIndex];
    if (!point) return;
    if (p.downed) return this.host.tell(p.id, "You can't do that while you're down.");
    if (!canReach(point, p.x, p.z)) return this.host.tell(p.id, 'Get closer first.');
    if (op === JOB_OP.START) return this.start(p, point, pointIndex, active);
    if (op !== JOB_OP.USE || !active) return;
    const ctx = this.ctx(active.def, active.shift);
    const out = active.def.use(ctx, active.state, p, pointIndex);
    if (typeof out === 'string') return this.host.tell(p.id, out);
    this.apply(p, active, out, ctx);
  }

  private start(p: JobPlayer, point: InteractionPoint, index: number, active: Active | undefined) {
    const def = [...this.defs.values()].find((d) => d.offeredAt === point.kind);
    if (!def) return;
    if (active)
      return this.host.tell(
        p.id,
        `You're on a ${active.def.title.toLowerCase()} shift. Finish or quit it first.`,
      );
    if (!p.account && !this.host.anonymousOk)
      return this.host.tell(p.id, 'Log in to work: your pay goes to your account.');
    const level = levelOf(p.xp).level;
    if (def.minLevel && level < def.minLevel)
      return this.host.tell(p.id, `${def.title} needs level ${def.minLevel}.`);
    const wait = (this.cooldowns.get(`${p.account}:${def.id}`) ?? 0) - this.host.now();
    if (wait > 0)
      return this.host.tell(
        p.id,
        `Take a breather: ${def.title.toLowerCase()} again in ${Math.ceil(wait / 1000)} s.`,
      );
    this.seq += 1;
    const shift = `${this.host.now().toString(36)}${this.seq.toString(36)}`;
    const ctx = this.ctx(def, shift);
    const state = def.start(ctx, p, index);
    if (typeof state === 'string') return this.host.tell(p.id, state);
    const a: Active = { def, state, shift, paying: Promise.resolve(), view: '', warnedFor: 0 };
    this.active.set(p.id, a);
    this.push(p.id, a, ctx);
    this.persist(p, a);
  }

  private apply(p: JobPlayer, a: Active, out: Outcome<unknown>, ctx: JobContext) {
    if (out.say) this.host.tell(p.id, out.say);
    if (out.pay) this.pay(p, a, out.pay);
    if (out.settle && p.account)
      this.host.settle(p.account).catch((e: unknown) => {
        console.error('job settlement failed', e);
        this.host.tell(p.id, e instanceof Error ? e.message : 'That payment didn’t go through.');
      });
    if (out.state === null) {
      this.finish(p, a);
      return;
    }
    a.state = out.state;
    this.push(p.id, a, ctx);
    this.persist(p, a);
  }

  /**
   * Pays through the API, in order. A pay the API couldn't take (asleep, down, a network
   * error) is tried again with the same key, so it's paid once however many tries it takes;
   * one it turned down is not, and the player is told why. Past the hourly or daily job pay
   * limit only part is paid, and the player is told that too.
   */
  private pay(p: JobPlayer, a: Active, pay: Pay) {
    const account = p.account ?? (this.host.anonymousOk ? `anon:${p.id}` : null);
    if (!account) return;
    const money = `$${(pay.cents / 100).toFixed(2)}`;
    const attempt = async (tries: number): Promise<void> => {
      try {
        const r = await this.host.reward(account, pay);
        this.host.rewarded(p.id, { ...r, reason: pay.reason });
        if (r.cents < pay.cents)
          this.host.tell(
            p.id,
            `Job pay is limited to ${dollars(FAUCETS.jobs.perHour)} an hour and ${dollars(FAUCETS.jobs.perDay)} a day: $${(r.cents / 100).toFixed(2)} of ${money} was paid.`,
          );
      } catch (e) {
        console.error('job reward failed', e);
        const status = (e as { status?: number }).status;
        const busy = status === undefined || status >= 500;
        const wait = PAY_RETRY_MS[tries];
        if (busy && wait !== undefined) {
          if (tries === 0)
            this.host.tell(
              p.id,
              `The bank isn't answering: your ${money} will be paid when it does.`,
            );
          await this.host.wait(wait);
          return attempt(tries + 1);
        }
        this.host.tell(
          p.id,
          busy
            ? `Your ${money} couldn't be paid: the bank is down. Type /help and an admin will sort it out.`
            : `The bank turned down your ${money}: ${e instanceof Error ? e.message : String(e)}. Type /help and an admin will sort it out.`,
        );
      }
    };
    a.paying = a.paying.then(() => attempt(0));
  }

  private finish(p: JobPlayer, a: Active) {
    this.active.delete(p.id);
    if (p.account) {
      this.cooldowns.set(`${p.account}:${a.def.id}`, this.host.now() + a.def.cooldownMs);
      void this.host.save(p.account, null).catch(() => {});
    }
    this.host.send(p.id, '');
  }

  /** Quits (or expires) the shift, paying what the job pays for that. */
  private end(p: JobPlayer, a: Active | undefined, why: 'quit' | 'expired', say?: string) {
    if (!a) return;
    const ctx = this.ctx(a.def, a.shift);
    const out = a.def.quit?.(ctx, a.state);
    if (out?.pay) this.pay(p, a, out.pay);
    this.host.tell(
      p.id,
      say ?? out?.say ?? `${a.def.title} shift ${why === 'quit' ? 'ended' : 'over'}.`,
    );
    this.finish(p, a);
  }

  /** Once a second: shifts that ran out. */
  tick(players: Iterable<JobPlayer>): void {
    for (const p of players) {
      const a = this.active.get(p.id);
      if (!a?.def.expired) continue;
      const ctx = this.ctx(a.def, a.shift);
      const why = a.def.expired(ctx, a.state);
      if (why) {
        this.end(p, a, 'expired', why);
        continue;
      }
      this.push(p.id, a, ctx);
      // A warning before a shift ends by itself, so it doesn't come as a surprise.
      const endsAt = a.def.view(ctx, a.state).endsAt;
      if (endsAt && endsAt - ctx.now < WARN_MS && a.warnedFor !== endsAt) {
        a.warnedFor = endsAt;
        const mins = Math.max(1, Math.round((endsAt - ctx.now) / 60_000));
        this.host.tell(
          p.id,
          `⏱ Your ${a.def.title.toLowerCase()} shift ends in ${mins} min${a.def.keepAlive ? ` unless you ${a.def.keepAlive}` : ''}.`,
        );
      }
    }
  }

  /** A logged-in player arrived: their saved shift, if any, carries on. */
  async joined(p: JobPlayer): Promise<void> {
    if (!p.account || this.active.has(p.id)) return;
    const saved = await this.host.load(p.account).catch(() => null);
    const def = saved ? this.defs.get(saved.job) : undefined;
    if (!saved || !def || this.active.has(p.id)) return;
    const a: Active = {
      def,
      state: saved.state,
      shift: saved.shift,
      paying: Promise.resolve(),
      view: '',
      warnedFor: 0,
    };
    this.active.set(p.id, a);
    this.push(p.id, a, this.ctx(def, a.shift), true);
    this.host.tell(p.id, `Welcome back: your ${def.title.toLowerCase()} shift carries on.`);
  }

  /** The player left the server (their shift stays saved for next time). */
  left(playerId: number): void {
    this.active.delete(playerId);
    this.lastAt.delete(playerId);
  }

  /** Sends the view when it changed (or always, e.g. after a reconnect). */
  private push(playerId: number, a: Active, ctx: JobContext, force = false) {
    const v = a.def.view(ctx, a.state);
    // The HUD counts down to it on the server's timeline, not the wall clock.
    if (v.endsAt !== undefined) v.endsAt = this.host.serverTime(v.endsAt);
    const view = JSON.stringify(v);
    if (!force && view === a.view) return;
    a.view = view;
    this.host.send(playerId, view);
  }

  /** Resend (after a reconnect within the ghost window). */
  resend(playerId: number): void {
    const a = this.active.get(playerId);
    if (a) this.push(playerId, a, this.ctx(a.def, a.shift), true);
  }

  private persist(p: JobPlayer, a: Active) {
    if (!p.account) return;
    void this.host
      .save(p.account, { job: a.def.id, shift: a.shift, state: a.state })
      .catch((e: unknown) => console.error('job save failed', e));
  }
}
