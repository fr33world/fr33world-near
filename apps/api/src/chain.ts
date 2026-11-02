/**
 * Car certificates on Solana (Phase 11; D-09, D-22; packages/chain). Deliver first: a car a
 * full account buys is theirs in the game at once, and its certificate (a Metaplex Core asset,
 * frozen, the game holding the transfer and freeze delegates) is minted to their embedded
 * wallet in the background. A sale on the market moves it. Every write is idempotent (the
 * asset address comes from the car's id), so a retry never mints twice; failures back off.
 * Reconciliation reads the chain for a few cars at a time and flags any that disagree.
 *
 * Runs only with CHAIN_AUTHORITY_SECRET set (the game's key, server-only); without it the queue
 * just waits.
 */
import { CAR_MODELS } from '@fr33world/shared';
import type { Db, Tx } from './db.ts';

/** Queues a newly bought car's certificate. */
export async function queueMint(tx: Db | Tx, carId: number): Promise<void> {
  await tx.query(
    "insert into car_chain (car_id, status) values ($1, 'mint') on conflict (car_id) do nothing",
    [carId],
  );
}

/** A car changed owner: its certificate follows (or, not minted yet, mints to the new owner). */
export async function queueTransfer(tx: Db | Tx, carId: number): Promise<void> {
  await tx.query(
    `update car_chain set status = case when status = 'mint' then 'mint' else 'transfer' end,
       wallet = null, attempts = 0, next_at = now(), updated_at = now()
     where car_id = $1`,
    [carId],
  );
}

/** What the worker needs of the chain (packages/chain CarRegistry), so tests can stand in. */
export interface ChainWriter {
  mint(car: { carId: string; owner: string; name: string; uri: string; model: string }): Promise<{
    asset: string;
  }>;
  transfer(carId: string, to: string): Promise<{ asset: string }>;
  read(carId: string): Promise<{ owner: string } | null>;
}

export interface ChainWorkerDeps {
  db: Db;
  chain: ChainWriter;
  /** The account's embedded Solana wallet (Privy), or null (none yet, or a guest). */
  walletOf: (privyUser: string) => Promise<string | null>;
  /** Somewhere to say a car's chain and database disagree (monitor alerts). */
  alert: (text: string) => void;
  /** Public metadata for a model (the client hosts /nft/cars/<id>.json). */
  uri: (model: string) => string;
}

/** Up to `limit` due certificates: minted or moved, or put off with a longer wait on failure. */
export async function runChainQueue(d: ChainWorkerDeps, limit = 3): Promise<number> {
  const due = await d.db.query<{
    car_id: number;
    status: 'mint' | 'transfer';
    wallet: string | null;
    attempts: number;
    model: number;
    privy: string;
    guest: boolean;
  }>(
    `select q.car_id, q.status, q.wallet, q.attempts, c.model, a.privy_user_id as privy,
            a.is_guest as guest
     from car_chain q join owned_cars c on c.id = q.car_id join accounts a on a.id = c.account_id
     where q.status in ('mint', 'transfer') and q.next_at <= now()
     order by q.next_at limit $1`,
    [limit],
  );
  let done = 0;
  for (const job of due.rows) {
    const carId = String(job.car_id);
    try {
      // Guests have no wallet: the certificate waits until they link an account.
      const wallet = job.wallet ?? (job.guest ? null : await d.walletOf(job.privy));
      if (!wallet) throw new Error('no wallet yet');
      const model = CAR_MODELS[job.model];
      const result =
        job.status === 'mint'
          ? await d.chain.mint({
              carId,
              owner: wallet,
              name: `${model?.name ?? 'Car'} #${carId}`,
              uri: d.uri(model?.id ?? 'car'),
              model: model?.id ?? 'car',
            })
          : await d.chain.transfer(carId, wallet);
      await d.db.query(
        `update car_chain set status = 'done', wallet = $2, asset = $3, attempts = 0,
           last_error = null, updated_at = now() where car_id = $1`,
        [job.car_id, wallet, result.asset],
      );
      done += 1;
    } catch (e) {
      // Back off: a minute, then doubling, to six hours at most.
      const wait = Math.min(6 * 3600, 60 * 2 ** job.attempts);
      await d.db.query(
        `update car_chain set attempts = attempts + 1, last_error = $2,
           next_at = now() + make_interval(secs => $3), updated_at = now() where car_id = $1`,
        [job.car_id, (e instanceof Error ? e.message : String(e)).slice(0, 300), wait],
      );
    }
  }
  return done;
}

/** Checks a few minted cars (least recently checked first) against the chain. */
export async function reconcile(d: ChainWorkerDeps, limit = 5): Promise<number> {
  const r = await d.db.query<{ car_id: number; wallet: string }>(
    `select car_id, wallet from car_chain where status = 'done' and wallet is not null
     order by updated_at limit $1`,
    [limit],
  );
  let bad = 0;
  for (const row of r.rows) {
    try {
      const onChain = await d.chain.read(String(row.car_id));
      const ok = onChain?.owner === row.wallet;
      await d.db.query(
        `update car_chain set status = $2, updated_at = now(), last_error = $3 where car_id = $1`,
        [
          row.car_id,
          ok ? 'done' : 'mismatch',
          ok ? null : `chain owner ${onChain?.owner ?? 'none'}`,
        ],
      );
      if (!ok) {
        bad += 1;
        d.alert(
          `Car ${row.car_id}: the chain says ${onChain?.owner ?? 'no asset'}, the game ${row.wallet}`,
        );
      }
    } catch {
      // The RPC had a bad moment: next time.
    }
  }
  return bad;
}
