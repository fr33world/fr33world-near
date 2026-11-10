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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
      if (!access) throw new Error('Make a full account to use USDC.');
      const s = await startUsdcSale(await access.token(), item.id);
      const signature = await access.sign(s.hash);
      await finishUsdcSale(await access.token(), { sale: s.sale, tx: s.tx, signature });
      return `${item.name} bought. It’s in your bag.`;
    });

  const take = (job: EconomyJob) =>
    run(async () => {
      if (!access) throw new Error('Make a full account to take USDC jobs.');
      await takeUsdcJob(await access.token(), job.id);
      return 'Job taken. Load up at Harbor Wholesale’s dock, then bring it here.';
    });

  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet glass guide gun-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="gun-badge">◆</span>
          <div>
            <div className="sheet-title">Sunny's Grocery</div>
            <div className="sheet-note">Run by itself: its stock, its prices, its own wallet.</div>
          </div>
        </div>
        {shelf.map((item) => (
          <div key={item.id} className="till-row">
            <div className="till-good">
              <b>{item.name}</b>
              <span>
                +{item.heal} health · {item.stock > 0 ? `${item.stock} left` : 'sold out'}
              </span>
            </div>
            {item.cents !== null && (
              <button
                type="button"
                className="btn"
                disabled={busy || item.stock === 0}
                onClick={() => {
                  const i = GOODS.findIndex((g) => g.id === item.id);
                  setSaid(game.buyGood(i) ? 'One moment…' : "You're offline.");
                  window.setTimeout(refresh, 1200);
                }}
              >
                {formatMoney(item.cents)}
              </button>
            )}
            <button
              type="button"
              className="btn till-usdc"
              disabled={busy || item.stock === 0 || !access}
              onClick={() => void buyUsdc(item)}
            >
              ◎ {formatUsdc(item.micro)}
            </button>
          </div>
        ))}
        <div className="bank-title">Deliveries that pay USDC</div>
        {jobs.length === 0 && <div className="bank-empty">No deliveries needed right now.</div>}
        {jobs.map((job) => (
          <div key={job.id} className="till-row">
            <div className="till-good">
              <b>Bring an order from Harbor Wholesale</b>
              <span>Level {JOB_RULES.minLevel}+, full accounts</span>
            </div>
            <button
              type="button"
              className="btn till-usdc"
              disabled={busy || !access}
              onClick={() => void take(job)}
            >
              ◎ {formatUsdc(Number(job.amount))}
            </button>
          </div>
        ))}
        {said && <div className="sheet-note">{said}</div>}
      </div>
    </div>
  );
}
