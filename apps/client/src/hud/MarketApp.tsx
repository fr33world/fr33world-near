/**
 * The phone's Market app (Phase 11; shared MARKET, CAR_ASSETS; owner, 2026-11-13): cars other
 * players are selling, and your own to put up for sale. A seller asks `$`, USDC, or both, and
 * the buyer chooses. `$` sales keep the market's floor and ceiling and a 5% fee to the city.
 * A car's title deed is on NEAR, so a USDC sale happens on chain: the buyer's own USDC pays the
 * seller directly and Sol Motors keeps 5%. Anything on chain is signed on this device.
 */
import {
  CAR_ASSETS,
  CAR_MODELS,
  carPrice,
  fairUsdc,
  formatUsdc,
  MARKET,
  USDC,
} from '@fr33world/shared';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney, type GarageCar, type Listing } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { UsdcMark } from '../ui/Modal.tsx';

const usdcFigure = (micro: number) => formatUsdc(micro).replace(' USDC', '');
const cents = (text: string) => Math.round(Number(text.replace(/[$,\s]/g, '')) * 100);
const micros = (text: string) => Math.round(Number(text.replace(/[,\s]/g, '')) * USDC);

export function MarketApp({ game }: { game: Game }) {
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [list, setList] = useState<Listing[] | null>(null);
  const [cars, setCars] = useState<GarageCar[] | null>(null);
  const [dollars, setDollars] = useState<Record<number, string>>({});
  const [usdc, setUsdc] = useState<Record<number, string>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = game.playerName;

  const load = useCallback(() => {
    void game.listings().then(setList, () => setList([]));
    void game.garage().then(setCars, () => setCars([]));
  }, [game]);
  useEffect(load, [load]);

  const run = (work: (step: (what: string) => void) => Promise<string>) => {
    setBusy(true);
    setSaid('One moment…');
    work((what) => setSaid(`Signing: ${what}…`))
      .then(
        (done) => setSaid(done),
        (e: unknown) => setSaid(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  const buyDollars = (l: Listing) =>
    run(async () => {
      await game.market('buy', { id: l.id });
      return `The ${l.name} is yours: it's in your garage${l.token ? ', and its deed in your wallet' : ''}.`;
    });
  const buyUsdc = (l: Listing) =>
    run(async (step) => {
      await game.carSteps('market/buy-usdc', { id: l.id }, step);
      void game.statement().catch(() => {});
      return `The ${l.name} is yours, paid in USDC on chain. Its deed is in your wallet.`;
    });
  const takeDown = (l: Listing) =>
    run(async (step) => {
      await game.carSteps('market/withdraw', { id: l.id }, step);
      return 'Taken down.';
    });
  const sell = (c: GarageCar) =>
    run(async (step) => {
      const d = dollars[c.id]?.trim();
      const u = usdc[c.id]?.trim();
      await game.carSteps(
        'market/list',
        { car: c.id, price: d ? cents(d) : null, micro: u ? micros(u) : null },
        step,
      );
      return `Your ${c.name} is for sale.`;
    });

  return (
    <div className="bank">
      <div className="market-tabs">
        <button type="button" className={tab === 'buy' ? 'on' : ''} onClick={() => setTab('buy')}>
          For sale
        </button>
        <button type="button" className={tab === 'sell' ? 'on' : ''} onClick={() => setTab('sell')}>
          Sell yours
        </button>
      </div>
      {said && <div className="bank-sub">{said}</div>}
      {tab === 'buy' &&
        (list === null ? (
          <div className="bank-sub">Opening…</div>
        ) : list.length === 0 ? (
          <div className="bank-sub">Nothing for sale right now.</div>
        ) : (
          list.map((l) => {
            const spec = CAR_MODELS[l.model];
            const mine = l.seller === me;
            return (
              <div key={l.id} className="bank-card garage-card market-card">
                <div className="market-top">
                  {spec && <img className="garage-photo" src={`/ui/cars/${spec.id}.webp`} alt="" />}
                  <div className="market-info">
                    <div className="bank-balance" style={{ fontSize: 20 }}>
                      {l.name}
                    </div>
                    {l.token && <span className="deed-tag">On NEAR</span>}
                    <div className="bank-sub">From {l.seller}</div>
                  </div>
                </div>
                <div className="market-buy">
                  {mine ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => takeDown(l)}
                    >
                      Take down
                    </button>
                  ) : (
                    <>
                      {l.price !== null && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => buyDollars(l)}
                        >
                          {formatMoney(l.price)}
                        </button>
                      )}
                      {l.micro !== null && (
                        <button
                          type="button"
                          className="btn btn-usdc"
                          disabled={busy || !game.usdcAccess()}
                          onClick={() => buyUsdc(l)}
                        >
                          <UsdcMark size={13} />
                          {usdcFigure(l.micro)}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        ))}
      {tab === 'sell' &&
        (cars === null ? (
          <div className="bank-sub">Opening…</div>
        ) : (
          <>
            <div className="bank-sub">
              Ask $, USDC or both: the buyer chooses. In $, between{' '}
              {Math.round(MARKET.floorShare * 100)}% and {Math.round(MARKET.ceilingShare * 100)}% of
              the dealer’s price, and the city keeps {Math.round(MARKET.feeShare * 100)}%. In USDC,
              you’re paid on chain and Sol Motors keeps {CAR_ASSETS.feeBps / 100}%.
            </div>
            {cars
              .filter((c) => !c.expiresAt)
              .map((c) => {
                const spec = CAR_MODELS[c.model];
                const base = carPrice(c.model) ?? 0;
                const fair = fairUsdc(c.model);
                const listed = list?.find((l) => l.car_id === Number(c.id));
                const ready = Boolean(dollars[c.id]?.trim() || usdc[c.id]?.trim());
                return (
                  <div key={c.id} className="bank-card garage-card market-card">
                    <div className="market-top">
                      {spec && (
                        <img className="garage-photo" src={`/ui/cars/${spec.id}.webp`} alt="" />
                      )}
                      <div className="market-info">
                        <div className="bank-balance" style={{ fontSize: 20 }}>
                          {c.name}
                        </div>
                        {c.minted && <span className="deed-tag">On NEAR</span>}
                        {listed && (
                          <div className="bank-sub">
                            For sale at{' '}
                            {[
                              listed.price !== null && formatMoney(listed.price),
                              listed.micro !== null && formatUsdc(listed.micro),
                            ]
                              .filter(Boolean)
                              .join(' or ')}
                          </div>
                        )}
                      </div>
                    </div>
                    {!listed && (
                      <div className="market-prices">
                        <input
                          className="field"
                          inputMode="numeric"
                          placeholder={`$ ${(base * MARKET.floorShare) / 100}–${(base * MARKET.ceilingShare) / 100}`}
                          value={dollars[c.id] ?? ''}
                          onChange={(e) => setDollars((p) => ({ ...p, [c.id]: e.target.value }))}
                        />
                        {c.minted ? (
                          <input
                            className="field"
                            inputMode="decimal"
                            placeholder={`USDC${fair ? ` (worth ~${usdcFigure(fair)})` : ''}`}
                            value={usdc[c.id] ?? ''}
                            onChange={(e) => setUsdc((p) => ({ ...p, [c.id]: e.target.value }))}
                          />
                        ) : (
                          <div className="bank-sub">USDC once its deed is in your wallet</div>
                        )}
                      </div>
                    )}
                    {listed ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => takeDown(listed)}
                      >
                        Take down
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy || !ready}
                        onClick={() => sell(c)}
                      >
                        Sell
                      </button>
                    )}
                  </div>
                );
              })}
            {cars.filter((c) => !c.expiresAt).length === 0 && (
              <div className="bank-sub">No cars to sell</div>
            )}
          </>
        ))}
    </div>
  );
}
