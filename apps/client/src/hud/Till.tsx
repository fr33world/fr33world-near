/**
 * Sunny's till (Phase 17): goods for `$` or USDC, and delivery jobs that pay USDC. Stock
 * and prices are the business's own, read live. USDC prices show the mark and the word, never a
 * bare `$`, so the two can't be mistaken for each other (D-44).
 */
import { formatUsdc, GOODS, JOB_RULES } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import {
  type EconomyJob,
  fetchOpenJobs,
  fetchShelf,
  finishUsdcSale,
  formatMoney,
  type ShelfItem,
  startUsdcSale,
  takeUsdcJob,
} from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Funds, Modal, Price, Said, Tile, UsdcMark } from '../ui/Modal.tsx';

export function TillSheet({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [jobs, setJobs] = useState<EconomyJob[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const access = game.usdcAccess();

  const refresh = () => {
    void fetchShelf().then(setShelf);
    void fetchOpenJobs().then(setJobs);
  };

  useEffect(() => {
    game.onTill = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setSaid(null);
      setOpen(true);
      refresh();
    };
    return () => {
      game.onTill = () => {};
    };
  }, [game]);

  if (!open) return null;

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setSaid('One moment…');
    try {
      setSaid(await work());
      refresh();
      void game.refreshUsdc().catch(() => {});
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  };

  const buyUsdc = (item: ShelfItem) =>
    run(async () => {
      if (!access) throw new Error('Full account needed.');
      const s = await startUsdcSale(await access.token(), item.id);
      const signature = await access.sign(s.hash);
      await finishUsdcSale(await access.token(), { sale: s.sale, tx: s.tx, signature });
      return `${item.name} in your bag.`;
    });

  const take = (job: EconomyJob) =>
    run(async () => {
      if (!access) throw new Error('Full account needed.');
      await takeUsdcJob(await access.token(), job.id);
      return 'Taken. Load up at Harbor’s dock.';
    });

  return (
    <Modal
      title="Sunny's Grocery"
      accent="#ffb02e"
      art="/ui/shop/meal.webp"
      medal="shop"
      head={<Funds game={game} />}
      onClose={() => setOpen(false)}
    >
      <div className="m-tiles">
        {shelf.map((item, n) => (
          <Tile
            key={item.id}
            index={n}
            art={`/ui/shop/${item.id}.webp`}
            name={item.name}
            dim={item.stock === 0}
            meta={`+${item.heal} HP · ${item.stock > 0 ? `${item.stock} left` : 'Sold out'}`}
          >
            {item.cents !== null && (
              <Price
                label={formatMoney(item.cents)}
                disabled={busy || item.stock === 0}
                onClick={() => {
                  const i = GOODS.findIndex((g) => g.id === item.id);
                  setSaid(game.buyGood(i) ? 'One moment…' : "You're offline.");
                  window.setTimeout(refresh, 1200);
                }}
              />
            )}
            <Price
              usdc
              label={formatUsdc(item.micro).replace(' USDC', '')}
              disabled={busy || item.stock === 0 || !access}
              onClick={() => void buyUsdc(item)}
            />
          </Tile>
        ))}
      </div>
      <Said text={said} />
      <h3 className="m-section">
        <UsdcMark /> Deliveries
      </h3>
      {jobs.length === 0 && <p className="m-empty">None right now</p>}
      {jobs.map((job) => (
        <div key={job.id} className="m-row">
          <div className="m-row-text">
            <b>Harbor Wholesale order</b>
            <small>Level {JOB_RULES.minLevel}+</small>
          </div>
          <Price
            usdc
            label={formatUsdc(Number(job.amount)).replace(' USDC', '')}
            disabled={busy || !access}
            onClick={() => void take(job)}
          />
        </div>
      ))}
    </Modal>
  );
}
