/**
 * World tickets: the API, having checked the player's login, signs a short-lived ticket naming
 * their account; the world server checks it with the shared secret in microseconds, with no
 * call to Privy and no database. The name inside is the account's real name, so nobody can
 * join under someone else's.
 *
 * Format: "wt1.<base64url JSON claims>.<base64url HMAC-SHA256>". Secret: WORLD_TICKET_SECRET,
 * the same on the API and the world server, at least 32 characters.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TicketClaims {
  /** accounts.id */
  account: string;
  /** The character's name (the account's name before it has one). */
  name: string;
  guest: boolean;
  /** The character's appearance (shared `encodeAppearance`), once made. */
  look?: number;
  /** The character's gear (shared `encodeGear`), when they have one. */
  gear?: number;
  /** The character's experience (shared `levelOf`), once made. */
  xp?: number;
  /** Staff only: their role and powers (shared `Staff`). */
  staff?: { role: 'super' | 'admin'; permissions: string[] };
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const PREFIX = 'wt1';
export const TICKET_TTL_S = 300;

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}.${body}`).digest();
}

export function signTicket(
  secret: string,
  claims: Omit<TicketClaims, 'exp'>,
  now = Date.now(),
  ttlS = TICKET_TTL_S,
): string {
  assertSecret(secret);
  const body = Buffer.from(
    JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + ttlS }),
  ).toString('base64url');
  return `${PREFIX}.${body}.${mac(secret, body).toString('base64url')}`;
}

export function verifyTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
): TicketClaims | null {
  const [prefix, body, sig] = ticket.split('.');
  if (prefix !== PREFIX || !body || !sig) return null;
  const expected = mac(secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as TicketClaims;
    if (typeof claims.account !== 'string' || typeof claims.name !== 'string') return null;
    if (claims.look !== undefined && !Number.isInteger(claims.look)) return null;
    if (claims.gear !== undefined && !Number.isInteger(claims.gear)) return null;
    if (claims.xp !== undefined && !Number.isInteger(claims.xp)) return null;
    if (
      claims.staff !== undefined &&
      (typeof claims.staff !== 'object' || !Array.isArray(claims.staff.permissions))
    )
      return null;
    if (!(claims.exp > Math.floor(now / 1000))) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * The key the world server shows the API on its own calls (bans, staff changes, the audit
 * log): derived from the shared ticket secret, so the secret itself never travels.
 */
export function internalKey(secret: string): string {
  assertSecret(secret);
  return createHmac('sha256', secret).update('fr33world-internal-v1').digest('base64url');
}

export function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < 32)
    throw new Error('WORLD_TICKET_SECRET must be at least 32 characters');
}
