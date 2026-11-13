/**
 * A hill villa's door (city 'home' points, shared HOMES): buy it for `$`, or see whose it is.
 * A home bought here is minted to the buyer's own NEAR wallet as its title deed (apps/api
 * homes.ts), so the sheet says where the deed is and links to it on the block explorer.
 */
import { HOME_ASSETS, HOMES, homePrice } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import type { Home } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Funds, Modal } from '../ui/Modal.tsx';

type Stage = 'look' | 'confirm' | 'buying';

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US')}`;

export function HomeSheet({ game }: { game: Game }) {
  const [point, setPoint] = useState<number | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [stage, setStage] = useState<Stage>('look');
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const money = game.hud.money;

  useEffect(() => {
    game.onHome = (p) => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setPoint(p);
    };
    return () => {
      game.onHome = () => {};
    };
  }, [game]);
  const villa = point === null ? null : (game.layout.points[point]?.home ?? null);
  useEffect(() => {
    if (villa === null) return;
    let alive = true;
    setStage('look');
    setError(null);
    setHome(game.homeList?.[villa] ?? null);
    const look = () =>
      game.homes().then(
        (all) => alive && setHome(all[villa] ?? null),
        (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    void look();
    // While its deed is on its way, look again until it's on chain.
    const t = setInterval(() => {
      const h = game.homeList?.[villa];
      if (h?.mine && !h.deed?.minted) void look();
    }, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [game, villa]);
  if (point === null || villa === null) return null;

  const close = () => setPoint(null);
  const [address, area] = HOMES[villa] ?? ['Villa', 0];
  const price = home?.price ?? homePrice(villa) ?? 0;
  const owned = (game.homeList ?? []).filter((h) => h.mine).length;
  const full = owned >= HOME_ASSETS.perPlayer;
  const short = money !== null && money < price;
  const buy = async () => {
    setStage('buying');
    setError(null);
    try {
      setHome(await game.buyHome(villa, key));
      setStage('look');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('confirm');
    }
  };

  const status = home?.mine ? 'Yours' : home?.owner ? home.owner : 'For sale';
  return (
    <Modal
      title={address}
      subtitle="A villa in the hills"
      size="lg"
      className="m-home"
      head={<Funds game={game} dollars />}
      onClose={close}
    >
      <div className="m-home-grid">
        <img
          className="m-home-photo"
          src={`/ui/homes/villa-${villa}.webp`}
          alt=""
          draggable={false}
        />
        <div className="m-home-side">
          <dl className="m-home-facts">
            <dt>Price</dt>
            <dd className="m-home-price">{dollars(home?.price ?? price)}</dd>
            <dt>Size</dt>
            <dd>{area} m², two floors</dd>
            <dt>Owner</dt>
            <dd>{status}</dd>
            <dt>Title deed</dt>
            <dd>A token on NEAR, in the owner’s own wallet</dd>
          </dl>
          {error && <div className="login-error">{error}</div>}
          {action()}
        </div>
      </div>
    </Modal>
  );

  function action() {
    if (!home) return <p className="m-note">One moment…</p>;
    if (home.mine)
      return (
        <div className="m-confirm">
          <p>
            <b>It’s yours.</b>{' '}
            {home.deed?.minted
              ? 'Its title deed is in your NEAR wallet: no one can take it back, and you can send it to any NEAR account.'
              : 'Its title deed is on its way to your NEAR wallet…'}
          </p>
          {home.deed && (
            <p className="deed-line">
              <span className="m-token">{home.deed.token}</span>
              {home.deed.url && (
                <>
                  {' · '}
                  <a href={home.deed.url} target="_blank" rel="noreferrer">
                    See the deed on NEAR
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      );
    if (home.owner)
      return (
        <p className="m-note">
          {home.owner === 'Someone'
            ? 'Its deed is in a wallet outside the game.'
            : `${home.owner} owns this home.`}
        </p>
      );
    if (stage === 'look')
      return (
        <button
          type="button"
          className="m-btn go"
          disabled={short || full}
          onClick={() => {
            // One id for this purchase: tapping Buy again after a lost answer is the same one.
            setKey(`home-${crypto.randomUUID()}`);
            setStage('confirm');
          }}
        >
          {full
            ? `You own ${HOME_ASSETS.perPlayer} homes`
            : short
              ? `${dollars(price - (money ?? 0))} short`
              : `Buy for ${dollars(price)}`}
        </button>
      );
    return (
      <div className="m-confirm">
        <p>Pay {dollars(price)}? You’ll own it on NEAR, in your own wallet.</p>
        <div className="m-actions">
          <button
            type="button"
            className="m-btn"
            disabled={stage === 'buying'}
            onClick={() => setStage('look')}
          >
            Back
          </button>
          <button
            type="button"
            className="m-btn go"
            disabled={stage === 'buying'}
            onClick={() => void buy()}
          >
            {stage === 'buying' ? 'Paying…' : 'Buy it'}
          </button>
        </div>
      </div>
    );
  }
}
