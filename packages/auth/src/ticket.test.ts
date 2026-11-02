import { describe, expect, it } from 'vitest';
import { signTicket, verifyTicket } from './ticket.ts';

const secret = 'a-test-secret-that-is-long-enough-123';
const claims = { account: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', name: 'Ada', guest: false };

describe('world tickets', () => {
  it('round-trip within their lifetime', () => {
    const t = signTicket(secret, claims, 1_000_000);
    expect(verifyTicket(secret, t, 1_000_000 + 60_000)).toMatchObject(claims);
  });

  it('expire', () => {
    const t = signTicket(secret, claims, 1_000_000, 300);
    expect(verifyTicket(secret, t, 1_000_000 + 301_000)).toBeNull();
  });

  it('reject tampering, other secrets and junk', () => {
    const t = signTicket(secret, claims);
    const [p, body, sig] = t.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, name: 'Admin', exp: 9e9 })).toString(
      'base64url',
    );
    expect(verifyTicket(secret, `${p}.${forged}.${sig}`)).toBeNull();
    expect(verifyTicket('another-secret-that-is-long-enough-xyz', t)).toBeNull();
    expect(verifyTicket(secret, `${p}.${body}`)).toBeNull();
    expect(verifyTicket(secret, 'eyJhbGciOiJFUzI1NiJ9.x.y')).toBeNull();
  });

  it('refuse a short secret', () => {
    expect(() => signTicket('short', claims)).toThrow(/32 characters/);
  });
});
