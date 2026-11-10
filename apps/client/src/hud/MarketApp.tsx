/**
 * The phone's Market app (Phase 11; shared MARKET): cars other players are selling, for `$`,
 * and your own to put up for sale (between the market's floor and ceiling for the model; a 5%
 * fee goes to the city). Bought cars land in your garage; their certificates follow on-chain.
 */
import { CAR_MODELS, carPrice, MARKET } from '@fr33world/shared';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney, type GarageCar, type Listing } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

export function MarketApp({ game }: { game: Game }) {
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [list, setList] = useState<Listing[] | null>(null);
  const [cars, setCars] = useState<GarageCar[] | null>(null);
  const [price, setPrice] = useState<Record<number, string>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = game.playerName;

  const load = useCallback(() => {
    void game.listings().then(setList, () => setList([]));
    void game.garage().then(setCars, () => setCars([]));
  }, [game]);
  useEffect(load, [load]);
  const act = (what: 'list' | 'withdraw' | 'buy', body: object, done: string) => {
    setBusy(true);
    game
      .market(what, body)
      .then(
        () => setSaid(done),
        (e: unknown) => setSaid(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        setBusy(false);
        load();
      });
  };

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
              <div key={l.id} className="bank-card garage-card">
                {spec && <img className="garage-photo" src={`/ui/cars/${spec.id}.webp`} alt="" />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="bank-balance" style={{ fontSize: 20 }}>
                    {l.name} · {formatMoney(l.price)}
                  </div>
                  <div className="bank-sub">From {l.seller}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    mine
                      ? act('withdraw', { id: l.id }, 'Taken down.')
                      : act('buy', { id: l.id }, `The ${l.name} is yours: it's in your garage.`)
                  }
                >
                  {mine ? 'Take down' : 'Buy'}
                </button>
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
              Price it between {Math.round(MARKET.floorShare * 100)}% and{' '}
              {Math.round(MARKET.ceilingShare * 100)}% of the dealership's price. The city keeps{' '}
              {Math.round(MARKET.feeShare * 100)}%. Full accounts only.
            </div>
            {cars
              .filter((c) => !c.expiresAt)
              .map((c) => {
                const spec = CAR_MODELS[c.model];
                const base = carPrice(c.model) ?? 0;
                const listed = list?.find((l) => l.car_id === Number(c.id));
                return (
                  <div key={c.id} className="bank-card garage-card">
                    {spec && (
                      <img className="garage-photo" src={`/ui/cars/${spec.id}.webp`} alt="" />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="bank-balance" style={{ fontSize: 20 }}>
                        {c.name}
                      </div>
                      {listed ? (
                        <div className="bank-sub">For sale at {formatMoney(listed.price)}</div>
                      ) : (
                        <input
                          className="field"
                          inputMode="numeric"
                          placeholder={`$ ${(base * MARKET.floorShare) / 100}–${(base * MARKET.ceilingShare) / 100}`}
                          value={price[Number(c.id)] ?? ''}
                          onChange={(e) =>
                            setPrice((p) => ({ ...p, [Number(c.id)]: e.target.value }))
                          }
                        />
                      )}
                    </div>
                    {!listed && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy || !price[Number(c.id)]}
                        onClick={() =>
                          act(
                            'list',
                            {
                              car: Number(c.id),
                              price: Math.round(
                                Number((price[Number(c.id)] ?? '').replace(/[$,\s]/g, '')) * 100,
                              ),
                            },
                            `Your ${c.name} is for sale.`,
                          )
                        }
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
