/**
 * Runs against a real PostgreSQL database (TEST_DATABASE_URL, default the local
 * fr33world_test; `pnpm db:start` first), in a schema rebuilt from the migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, inTx } from './db.ts';
import {
  AccountFrozen,
  audit,
  balanceOf,
  InsufficientFunds,
  LedgerError,
  post,
  setFrozen,
  systemAccount,
  transfer,
  walletOf,
} from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;

async function newPlayer(): Promise<{ id: string; wallet: number }> {
  n += 1;
  const r = await db.query<{ id: string }>(
    'insert into accounts (privy_user_id, display_name) values ($1, $2) returning id',
    [`did:privy:test-${Date.now()}-${n}`, `Player ${n}`],
  );
  const id = (r.rows[0] as { id: string }).id;
  return { id, wallet: await walletOf(db, id) };
}

async function fund(wallet: number, cents: number, key = `fund-${wallet}-${cents}-${n++}`) {
  const faucet = await systemAccount(db, 'faucet:signup');
  return transfer(db, {
    kind: 'signup_bonus',
    key,
    legs: [
      { account: faucet, amount: -cents },
      { account: wallet, amount: cents },
    ],
  });
}

beforeAll(async () => {
  db = await testDb('ledger');
});

afterAll(async () => {
  await db.end();
});

describe('ledger', () => {
  it('pays a sign-up bonus once, however often it is retried', async () => {
    const p = await newPlayer();
    const first = await fund(p.wallet, 500_000, `signup:${p.id}`);
    const again = await fund(p.wallet, 500_000, `signup:${p.id}`);
    expect(first.status).toBe('posted');
    expect(again).toEqual({ status: 'duplicate', txId: first.txId });
    expect(await balanceOf(db, p.wallet)).toBe(500_000);
  });

  it('refuses an overdraft and leaves no trace of it', async () => {
    const buyer = await newPlayer();
    await fund(buyer.wallet, 10_000);
    const sink = await systemAccount(db, 'sink:purchases');
    const before = await audit(db);
    await expect(
      transfer(db, {
        kind: 'car_purchase',
        key: `overdraft-${buyer.id}`,
        legs: [
          { account: buyer.wallet, amount: -10_001 },
          { account: sink, amount: 10_001 },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    expect(await balanceOf(db, buyer.wallet)).toBe(10_000);
    // The failed attempt didn't consume its key either.
    const tx = await db.query('select 1 from ledger_transactions where idempotency_key = $1', [
      `overdraft-${buyer.id}`,
    ]);
    expect(tx.rowCount).toBe(0);
    expect(await audit(db)).toEqual(before);
  });

  it('never spends the same money twice under concurrent purchases', async () => {
    const buyer = await newPlayer();
    await fund(buyer.wallet, 100_000);
    const sink = await systemAccount(db, 'sink:purchases');
    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        transfer(db, {
          kind: 'item_purchase',
          key: `race-${buyer.id}-${i}`,
          legs: [
            { account: buyer.wallet, amount: -10_000 },
            { account: sink, amount: 10_000 },
          ],
        }),
      ),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    const broke = attempts.filter(
      (a) => a.status === 'rejected' && a.reason instanceof InsufficientFunds,
    ).length;
    expect(ok).toBe(10);
    expect(broke).toBe(40);
    expect(await balanceOf(db, buyer.wallet)).toBe(0);
  });

  it('moves money between players and keeps the books closed', async () => {
    const seller = await newPlayer();
    const buyer = await newPlayer();
    await fund(buyer.wallet, 250_000);
    await transfer(db, {
      kind: 'trade',
      key: `trade-${buyer.id}-${seller.id}`,
      legs: [
        { account: buyer.wallet, amount: -200_000 },
        { account: seller.wallet, amount: 200_000 },
      ],
      memo: { car: 'sol-taxi' },
    });
    expect(await balanceOf(db, buyer.wallet)).toBe(50_000);
    expect(await balanceOf(db, seller.wallet)).toBe(200_000);
    const a = await audit(db);
    expect(a.total).toBe(0);
    expect(a.drifted).toBe(0);
    expect(a.unbalanced).toBe(0);
    expect(a.circulating).toBeGreaterThan(0);
  });

  it('rejects malformed postings before touching the database', async () => {
    const p = await newPlayer();
    const sink = await systemAccount(db, 'sink:fees');
    const bad = [
      { legs: [{ account: p.wallet, amount: -5 }] },
      {
        legs: [
          { account: p.wallet, amount: -5 },
          { account: sink, amount: 4 },
        ],
      },
      {
        legs: [
          { account: p.wallet, amount: -0.5 },
          { account: sink, amount: 0.5 },
        ],
      },
      {
        legs: [
          { account: p.wallet, amount: 0 },
          { account: sink, amount: 0 },
        ],
      },
    ];
    for (const b of bad) {
      await expect(transfer(db, { kind: 'fee', key: `bad-${n++}`, ...b })).rejects.toBeInstanceOf(
        LedgerError,
      );
    }
  });

  it('refuses a reused key for a different kind of transaction', async () => {
    const p = await newPlayer();
    await fund(p.wallet, 1_000, `shared-${p.id}`);
    const sink = await systemAccount(db, 'sink:fees');
    await expect(
      transfer(db, {
        kind: 'fee',
        key: `shared-${p.id}`,
        legs: [
          { account: p.wallet, amount: -1_000 },
          { account: sink, amount: 1_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('refuses a replayed key that asks for a different amount, and answers a true replay', async () => {
    const p = await newPlayer();
    const faucet = await systemAccount(db, 'faucet:jobs');
    const pay = (cents: number) =>
      transfer(db, {
        kind: 'job_pay',
        key: `job-${p.id}-1`,
        legs: [
          { account: faucet, amount: -cents },
          { account: p.wallet, amount: cents },
        ],
      });
    expect((await pay(300)).status).toBe('posted');
    expect((await pay(300)).status).toBe('duplicate');
    await expect(pay(300_000)).rejects.toBeInstanceOf(LedgerError);
    expect(await balanceOf(db, p.wallet)).toBe(300);
  });

  it('records who caused each transaction', async () => {
    const p = await newPlayer();
    const faucet = await systemAccount(db, 'faucet:corrections');
    const { txId } = await transfer(db, {
      kind: 'correction',
      key: `corr-${p.id}`,
      actor: 'staff:ada',
      legs: [
        { account: faucet, amount: -50 },
        { account: p.wallet, amount: 50 },
      ],
    });
    const r = await db.query<{ actor: string }>(
      'select actor from ledger_transactions where id = $1',
      [txId],
    );
    expect(r.rows[0]?.actor).toBe('staff:ada');
  });

  it('lets a frozen wallet be paid but not spend', async () => {
    const p = await newPlayer();
    await fund(p.wallet, 1_000);
    await setFrozen(db, p.wallet, true);
    await fund(p.wallet, 500);
    const sink = await systemAccount(db, 'sink:fees');
    const spend = () =>
      transfer(db, {
        kind: 'fee',
        key: `fee-${p.id}-${n++}`,
        legs: [
          { account: p.wallet, amount: -100 },
          { account: sink, amount: 100 },
        ],
      });
    await expect(spend()).rejects.toBeInstanceOf(AccountFrozen);
    expect(await balanceOf(db, p.wallet)).toBe(1_500);
    await setFrozen(db, p.wallet, false);
    expect((await spend()).status).toBe('posted');
  });
});

describe('the database itself holds the line (even against raw SQL)', () => {
  it('refuses an unbalanced transaction at commit', async () => {
    const p = await newPlayer();
    await expect(
      inTx(db, async (tx) => {
        const r = await tx.query<{ id: number }>(
          "insert into ledger_transactions (kind, idempotency_key) values ('hack', $1) returning id",
          [`hack-${p.id}`],
        );
        await tx.query(
          'insert into ledger_entries (tx_id, account_id, amount) values ($1, $2, $3)',
          [(r.rows[0] as { id: number }).id, p.wallet, 1_000_000_000],
        );
      }),
    ).rejects.toThrow(/does not balance/);
    expect(await balanceOf(db, p.wallet)).toBe(0);
  });

  it('refuses edits to history and direct balance changes', async () => {
    const p = await newPlayer();
    await fund(p.wallet, 100);
    await expect(db.query('update ledger_entries set amount = amount * 1000')).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('delete from ledger_transactions')).rejects.toThrow(/append-only/);
    await expect(
      db.query('update ledger_accounts set balance = 999999999 where id = $1', [p.wallet]),
    ).rejects.toThrow(/only through ledger entries/);
    expect(await balanceOf(db, p.wallet)).toBe(100);
  });

  it('posts inside a larger transaction and rolls back with it', async () => {
    const p = await newPlayer();
    const faucet = await systemAccount(db, 'faucet:jobs');
    await expect(
      inTx(db, async (tx) => {
        await post(tx, {
          kind: 'job_pay',
          key: `job-${p.id}`,
          legs: [
            { account: faucet, amount: -5_000 },
            { account: p.wallet, amount: 5_000 },
          ],
        });
        throw new Error('the job turned out invalid');
      }),
    ).rejects.toThrow(/invalid/);
    expect(await balanceOf(db, p.wallet)).toBe(0);
  });
});
