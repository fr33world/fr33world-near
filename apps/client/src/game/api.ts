import { type FactionId, type Gear } from '@fr33world/shared';
/**
 * The game API (apps/api): accounts, money and world tickets. VITE_API_URL in builds; in dev,
 * this host on port 7410.
 */
import type { Appearance } from '@fr33world/shared';

export interface ApiSession {
  account: { id: string; name: string; guest: boolean };
  /** The player's character, once made (`look`: shared `encodeAppearance`). */
  character: {
    name: string;
    age: number;
    look: number;
    gear: number;
    xp: number;
    tutorial: string;
  } | null;
  /** `$` in cents. */
  balance: number;
  /**
   * Onboarding still to do before the city ('age': date of birth, 'terms': acceptance,
   * 'character': making one).
   */
  needs: ('age' | 'terms' | 'character')[];
  /** World ticket for the world server's hello, once nothing is needed. */
  ticket: string | null;
  ticketTtl: number;
}

/** The API refused: `blocked` when the account may never play (e.g. under 18). */
export class ApiError extends Error {
  readonly status: number;
  readonly blocked: string | null;
  constructor(message: string, status: number, blocked: string | null) {
    super(message);
    this.status = status;
    this.blocked = blocked;
  }
}

export function apiUrl(): string {
  const built = import.meta.env.VITE_API_URL as string | undefined;
  return built || `http://${location.hostname}:7410`;
}

async function call(path: string, privyToken: string, body: object): Promise<ApiSession> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${privyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; blocked?: string };
    throw new ApiError(
      err.error ?? `The game server answered ${res.status}`,
      res.status,
      err.blocked ?? null,
    );
  }
  return (await res.json()) as ApiSession;
}

/**
 * Resolves once the API answers /health, retrying through a free-plan cold start (about a
 * minute). `onWaiting` runs after the first failed try.
 */
export async function wakeApi(
  onWaiting?: () => void,
  // In development nothing sleeps: a missing API is not running, so say so quickly.
  deadlineMs = import.meta.env.DEV ? 6_000 : 120_000,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  for (let tries = 0; ; tries += 1) {
    try {
      const res = await fetch(`${apiUrl()}/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
    } catch {
      // asleep or unreachable: retry below
    }
    if (performance.now() > deadline) {
      throw new Error(
        import.meta.env.DEV
          ? `The game API isn't running at ${apiUrl()}. Start everything with "pnpm db:start" then "pnpm dev".`
          : 'The game server is not answering. Try again soon.',
      );
    }
    if (tries === 0) onWaiting?.();
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Logs into the game with a Privy token: creates the account on first login. */
export function openApiSession(privyToken: string, name: string): Promise<ApiSession> {
  return call('/v1/session', privyToken, { name });
}

/** The 18+ date of birth (once) and the Terms acceptance. */
export function submitOnboarding(
  privyToken: string,
  answers: { birthDate?: string; termsVersion?: string },
): Promise<ApiSession> {
  return call('/v1/onboarding', privyToken, answers);
}

/** Makes the account's character (once). */
export function createCharacter(
  privyToken: string,
  character: { name: string; age: number; appearance: Appearance; gear: Gear },
): Promise<ApiSession> {
  return call('/v1/character', privyToken, character);
}

/** Whether a character name is free, and how it would be written; or why it can't be. */
export async function checkCharacterNameFree(
  name: string,
): Promise<{ name: string; available: boolean } | { error: string }> {
  const res = await fetch(`${apiUrl()}/v1/character/name?name=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(8_000),
  });
  return (await res.json()) as { name: string; available: boolean } | { error: string };
}

/** "$5,000" from cents (whole dollars; cents only when there are some). */
/** The character names this account has blocked. */
export async function fetchBlocks(privyToken: string): Promise<string[]> {
  const res = await fetch(`${apiUrl()}/v1/blocks`, {
    headers: { authorization: `Bearer ${privyToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`blocks: ${res.status}`);
  return ((await res.json()) as { blocked: string[] }).blocked;
}

/** Blocks or unblocks a character; returns the whole list. */
export async function setBlock(
  privyToken: string,
  name: string,
  blocked: boolean,
): Promise<string[]> {
  const res = await fetch(`${apiUrl()}/v1/blocks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${privyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, blocked }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { blocked?: string[]; error?: string };
  if (!res.ok || !body.blocked) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.blocked;
}

export const REPORT_REASONS = [
  ['harassment', 'Harassment'],
  ['hate', 'Hate speech'],
  ['cheating', 'Cheating'],
  ['spam', 'Spam'],
  ['random_killing', 'Killed me for no reason'],
  ['car_ramming', 'Ran me over on purpose'],
  ['other', 'Something else'],
] as const;

/** Reports a character to the admins. */
export async function sendReport(
  privyToken: string,
  r: { name: string; reason: string; details: string },
): Promise<void> {
  const res = await fetch(`${apiUrl()}/v1/reports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${privyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(r),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

/** One line of the bank's history (apps/api bank.ts). */
export interface BankItem {
  id: number;
  at: string;
  kind: string;
  /** Cents in (positive) or out (negative). */
  amount: number;
  other: string | null;
  note: string | null;
}

export interface Statement {
  balance: number;
  frozen: boolean;
  history: BankItem[];
  more: boolean;
}

async function bankCall<T>(privyToken: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${privyToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface Progress {
  xp: number;
  level: number;
  into: number;
  next: number;
  history: { id: number; source: string; reason: string; cents: number; xp: number; at: string }[];
}

/** Saves the tutorial's progress; 'done' pays its reward once. */
export function saveTutorial(
  privyToken: string,
  step: string,
): Promise<{ step: string; reward: { cents: number; xp: number; totalXp: number } | null }> {
  return bankCall(privyToken, '/v1/tutorial', { step });
}

/** The cars this account owns (a starter car the first time). */
/** A car in the garage: `expiresAt` when it's the newcomer's rental (ISO), else null. */
export interface GarageCar {
  id: number;
  model: number;
  name: string;
  expiresAt?: string | null;
}

export function fetchGarage(privyToken: string): Promise<{ cars: GarageCar[] }> {
  return bankCall(privyToken, '/v1/garage');
}

/** Buys a car at the dealership; `key` makes a retry the same purchase. */
export function buyCar(
  privyToken: string,
  model: number,
  key: string,
): Promise<{
  status: 'posted' | 'duplicate';
  car: { id: number; model: number; name: string };
  balance: number;
}> {
  return bankCall(privyToken, '/v1/dealer/buy', { model, key });
}

export interface Conversation {
  name: string;
  text: string;
  at: string;
  mine: boolean;
  unread: number;
}

export interface DirectMessage {
  id: number;
  text: string;
  at: string;
  mine: boolean;
}

export function fetchConversations(
  privyToken: string,
): Promise<{ conversations: Conversation[]; unread: number }> {
  return bankCall(privyToken, '/v1/messages');
}

export function fetchThread(
  privyToken: string,
  name: string,
): Promise<{ name: string; messages: DirectMessage[] }> {
  return bankCall(privyToken, `/v1/messages/thread?name=${encodeURIComponent(name)}`);
}

export function sendDirectMessage(privyToken: string, to: string, text: string) {
  return bankCall<DirectMessage>(privyToken, '/v1/messages', { to, text });
}

/** The login streak, the spin, today's tasks and unclaimed level bonuses. */
export interface DailyStatus {
  day: string;
  login: { claimed: boolean; streak: number };
  spin: { claimed: boolean };
  tasks: { id: string; done: number; claimed: boolean }[];
  levels: number[];
}

export interface DailyPaid {
  label: string;
  cents: number;
  xp: number;
  item?: string;
  totalXp: number;
  /** A spin: the wheel's slice. */
  slice?: number;
}

export function fetchDaily(privyToken: string): Promise<DailyStatus> {
  return bankCall(privyToken, '/v1/daily');
}

export function claimDaily(
  privyToken: string,
  body: { what: string; level?: number },
): Promise<DailyPaid> {
  return bankCall(privyToken, '/v1/daily/claim', body);
}

/** Level, XP and the latest rewards. */
export function fetchProgress(privyToken: string): Promise<Progress> {
  return bankCall(privyToken, '/v1/progress');
}

/** Balance and a page of history (older than `before`, a history id). */
export function fetchStatement(privyToken: string, before?: number): Promise<Statement> {
  return bankCall(privyToken, `/v1/bank${before ? `?before=${before}` : ''}`);
}

/** Pays another character; `key` is this send's own id, so a retry pays once. */
export function sendPayment(
  privyToken: string,
  p: { to: string; cents: number; note: string; key: string },
): Promise<{ status: string; balance: number; to: string }> {
  return bankCall(privyToken, '/v1/bank/pay', p);
}

export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The phone's Faction app (apps/api factions.ts). */
export interface FactionStatus {
  membership: { faction: FactionId; rank: number; title: string } | null;
  application: {
    faction: FactionId;
    stage: 'training' | 'interview';
    retryAt: string | null;
    quizSeed: number;
    interviewAt: string | null;
  } | null;
  roster: { name: string; rank: number }[];
}

/** The computer in a faction's building. */
export interface FactionDesk {
  factions: FactionId[];
  applicants: {
    name: string;
    faction: FactionId;
    stage: 'training' | 'interview';
    note: string;
    interviewAt: string | null;
  }[];
}

export function fetchDesk(privyToken: string): Promise<FactionDesk> {
  return bankCall(privyToken, '/v1/factions/desk');
}

/** The phone's gangs (apps/api gangs.ts). */
export interface GangStatus {
  gang: {
    name: string;
    tag: string;
    leader: boolean;
    accepted: boolean;
    members: string[];
    requests: string[];
  } | null;
  gangs: { id: number; name: string; tag: string; members: number }[];
  board: { name: string; tag: string; members: number; points: number }[];
  level: number;
}

export function fetchGangs(privyToken: string): Promise<GangStatus> {
  return bankCall(privyToken, '/v1/gangs');
}

export function gangAction(
  privyToken: string,
  action: 'create' | 'join' | 'leave' | 'decide',
  body: Record<string, unknown>,
): Promise<GangStatus> {
  return bankCall(privyToken, `/v1/gangs/${action}`, body);
}

export function fetchFactions(privyToken: string): Promise<FactionStatus> {
  return bankCall(privyToken, '/v1/factions');
}

export function applyFaction(
  privyToken: string,
  faction: FactionId,
  note: string,
): Promise<FactionStatus> {
  return bankCall(privyToken, '/v1/factions/apply', { faction, note });
}

export function takeFactionQuiz(
  privyToken: string,
  answers: number[],
): Promise<{ right: number; of: number; passed: boolean; status: FactionStatus }> {
  return bankCall(privyToken, '/v1/factions/quiz', { answers });
}

export function leaveFaction(privyToken: string): Promise<FactionStatus> {
  return bankCall(privyToken, '/v1/factions/leave', {});
}

/** The in-game inbox (apps/api inbox.ts); `read` marks everything read. */
export function fetchInbox(
  privyToken: string,
  read = false,
): Promise<{ notices: { id: number; text: string; at: string; read: boolean }[]; unread: number }> {
  return bankCall(privyToken, read ? '/v1/inbox/read' : '/v1/inbox', read ? {} : undefined);
}

/** A car for sale on the market (apps/api market.ts). */
export interface Listing {
  id: number;
  car_id: number;
  model: number;
  name: string;
  price: number;
  seller: string;
  listed_at: string;
}

export async function fetchListings(): Promise<Listing[]> {
  const res = await fetch(`${apiUrl()}/v1/market`, { signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { listings?: Listing[] };
  return data.listings ?? [];
}

export function marketCall(
  privyToken: string,
  what: 'list' | 'withdraw' | 'buy',
  body: object,
): Promise<unknown> {
  return bankCall(privyToken, `/v1/market/${what}`, body);
}

/** A good on Sunny's shelf. `cents` is null for goods sold for USDC only. */
export interface ShelfItem {
  id: string;
  name: string;
  heal: number;
  cents: number | null;
  micro: number;
  stock: number;
}

export interface EconomyJob {
  id: string;
  business: string;
  amount: string;
  status: string;
}

async function usdcCall<T>(token: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${apiUrl()}/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? 'That didn’t go through.');
  return data;
}

/** A player's USDC wallet: `token` and `explorer` come once it's linked. */
export interface UsdcWallet {
  near: string | null;
  micro: number;
  /** The one token this wallet shows, for the deposit screen. */
  token?: string;
  /** This account's page on the block explorer. */
  explorer?: string;
}

export const fetchUsdc = (token: string) => usdcCall<UsdcWallet>(token, 'usdc');
export const linkUsdc = (token: string) => usdcCall<{ near: string }>(token, 'usdc/link', {});
export const startUsdcSale = (token: string, good: string) =>
  usdcCall<{ sale: string; micro: number; tx: string; hash: `0x${string}` }>(token, 'usdc/sale', {
    good,
  });
export const finishUsdcSale = (
  token: string,
  body: { sale: string; tx: string; signature: string },
) => usdcCall<{ tx: string | null }>(token, 'usdc/sale/finish', body);
export const startUsdcSend = (token: string, to: string, micro: number) =>
  usdcCall<{ tx: string; hash: `0x${string}` }>(token, 'usdc/send', { to, micro });
export const finishUsdcSend = (token: string, tx: string, signature: string) =>
  usdcCall<{ tx: string }>(token, 'usdc/send/finish', { tx, signature });
/** Test USDC from the public testnet faucet: whether a claim would go through, and claiming. */
export const fetchTestUsdc = (token: string) =>
  usdcCall<{ micro: number; refused: string | null }>(token, 'usdc/faucet');
export const claimTestUsdc = (token: string) =>
  usdcCall<{ micro: number; tx: string }>(token, 'usdc/faucet', {});
export const takeUsdcJob = (token: string, job: string) =>
  usdcCall<{ ok: boolean }>(token, 'usdc/job', { job });

export async function fetchShelf(): Promise<ShelfItem[]> {
  const r = await fetch(`${apiUrl()}/v1/market/shelf`);
  return r.ok ? ((await r.json()) as ShelfItem[]) : [];
}

export async function fetchOpenJobs(): Promise<EconomyJob[]> {
  const r = await fetch(`${apiUrl()}/v1/economy`);
  if (!r.ok) return [];
  const e = (await r.json()) as { jobs: EconomyJob[] };
  return e.jobs.filter((j) => j.status === 'open');
}
