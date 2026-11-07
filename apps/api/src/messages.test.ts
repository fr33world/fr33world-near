import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.ts';
import { conversations, sendMessage, thread } from './messages.ts';
import { setBlocked } from './safety.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

beforeAll(async () => {
  db = await testDb('messages');
});
afterAll(async () => {
  await db.end();
});

async function player(opts: { guest?: boolean } = {}) {
  n += 1;
  const privy = `did:privy:msg-${Date.now()}-${n}`;
  const name = `Message Tester${n}`;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name, is_guest) values ($1, $2, $3) returning id',
    [privy, `M${n}`, opts.guest ?? false],
  );
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 25, 0)',
    [r.rows[0]!.id, name],
  );
  return { privy, name };
}

describe('messages', () => {
  it('reaches the other person, counts as unread, and reading clears it', async () => {
    const [a, b] = [await player(), await player()];
    await sendMessage(db, a.privy, { to: b.name, text: 'Meet at the pier?' });
    await sendMessage(db, a.privy, { to: b.name, text: 'At eight' });
    const inbox = await conversations(db, b.privy);
    expect(inbox.unread).toBe(2);
    expect(inbox.conversations[0]).toMatchObject({ name: a.name, text: 'At eight', unread: 2 });
    const t = await thread(db, b.privy, a.name);
    expect(t.messages.map((m) => [m.text, m.mine])).toEqual([
      ['Meet at the pier?', false],
      ['At eight', false],
    ]);
    expect((await conversations(db, b.privy)).unread).toBe(0);
    expect((await thread(db, a.privy, b.name)).messages.every((m) => m.mine)).toBe(true);
  });

  it('never shows one pair’s messages to anyone else', async () => {
    const [a, b, c] = [await player(), await player(), await player()];
    await sendMessage(db, a.privy, { to: b.name, text: 'secret' });
    expect((await conversations(db, c.privy)).conversations).toHaveLength(0);
    expect((await thread(db, c.privy, a.name)).messages).toHaveLength(0);
  });

  it('delivers nothing to someone who blocked you, and doesn’t say so', async () => {
    const [a, b] = [await player(), await player()];
    await setBlocked(db, b.privy, a.name, true);
    await expect(sendMessage(db, a.privy, { to: b.name, text: 'hey' })).resolves.toBeDefined();
    expect((await conversations(db, b.privy)).unread).toBe(0);
  });

  it('turns down guests, bad text and unknown names', async () => {
    const [a, guest] = [await player(), await player({ guest: true })];
    await expect(sendMessage(db, guest.privy, { to: a.name, text: 'hi' })).rejects.toThrow(
      /full account/,
    );
    await expect(sendMessage(db, a.privy, { to: 'Nobody Here', text: 'hi' })).rejects.toThrow(
      /Nobody/,
    );
    await expect(sendMessage(db, a.privy, { to: a.name, text: 'hi' })).rejects.toThrow(/you/);
    const b = await player();
    await expect(sendMessage(db, a.privy, { to: b.name, text: '   ' })).rejects.toThrow(
      /Say something/,
    );
    await expect(sendMessage(db, a.privy, { to: b.name, text: 'x'.repeat(301) })).rejects.toThrow(
      /300/,
    );
  });
});
