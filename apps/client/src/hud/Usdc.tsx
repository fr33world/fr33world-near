/**
 * USDC (Phase 17; D-44): real money, kept visibly apart from the game's `$`, with its own blue
 * mark and word. The top bar shows the balance, read from the chain, and a tap on it opens the
 * wallet: deposit, withdraw, and the record on the chain. Withdrawing is signed on this device,
 * so the game can't move a player's USDC for them. Nothing here turns `$` into USDC or back.
 */
import { formatUsdc, USDC } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import { finishUsdcSend, startUsdcSend } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

/** Between looks at the balance while playing (ms): deposits and delivery pay show up by this. */
const READ_EVERY = 60_000;

/** The figure alone: the word goes beside it, smaller. */
const figure = (micro: number) => formatUsdc(micro).replace(' USDC', '');

/** The balance in the top bar, beside the `$`. Guests have no wallet, so they don't see it. */
export function UsdcPill({ game }: { game: Game }) {
  const signedIn = game.usdcAccess() !== null;
  useEffect(() => {
    if (!signedIn) return;
    const read = () => {
      if (!document.hidden) void game.refreshUsdc().catch(() => {});
    };
    read();
    const id = window.setInterval(read, READ_EVERY);
    return () => window.clearInterval(id);
  }, [game, signedIn]);
  if (!signedIn) return null;
  return (
    <button
      type="button"
      className="glass hud-usdc"
      aria-label="Open USDC wallet"
      onClick={() => game.onWallet()}
    >
      <span className="usdc-coin" aria-hidden="true">
        ◎
      </span>
      {game.usdc ? figure(game.usdc.micro) : '…'}
      <small>USDC</small>
    </button>
  );
}

/** The card in the phone's Bank: the balance, and the way into the wallet. */
export function UsdcCard({ game }: { game: Game }) {
  const signedIn = game.usdcAccess() !== null;
  useEffect(() => {
    if (signedIn) void game.refreshUsdc().catch(() => {});
    // Once, when the card opens.
  }, []);
  if (!signedIn) return null;
  return (
    <div className="bank-card usdc-card">
      <div className="usdc-head">
        <span className="usdc-mark" aria-hidden="true">
          ◎
        </span>
        <div className="bank-name">USDC wallet</div>
        <span className="usdc-tag">Testnet: no real value</span>
      </div>
      <div className="bank-balance">{game.usdc ? formatUsdc(game.usdc.micro) : '…'}</div>
      <div className="bank-sub">Yours, on NEAR. Separate from your $.</div>
      <button type="button" className="btn" onClick={() => game.onWallet()}>
        Open wallet
      </button>
    </div>
  );
}

/** The wallet itself: what you hold, where to send USDC in, and taking it out. */
export function WalletSheet({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const access = game.usdcAccess();

  const read = async (link = false) => {
    try {
      await game.refreshUsdc(link);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'The wallet didn’t answer. Try again.');
    }
  };

  useEffect(() => {
    game.onWallet = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setNote(null);
      setReview(false);
      setCopied(false);
      setOpen(true);
      // Opening it is what sets the wallet up, the first time.
      void read(true);
    };
    return () => {
      game.onWallet = () => {};
    };
  }, [game]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || !access) return null;

  const wallet = game.usdc;
  const micro = wallet?.micro ?? 0;
  const value = Math.round(Number(amount) * USDC);
  const account = to.trim().toLowerCase();

  const copy = async () => {
    if (!wallet?.near) return;
    try {
      await navigator.clipboard.writeText(wallet.near);
      setCopied(true);
    } catch {
      setNote('Couldn’t copy. Press and hold the address instead.');
    }
  };

  const toReview = () => {
    if (!account) return setNote('Enter the NEAR account to send to.');
    if (!Number.isFinite(value) || value <= 0) return setNote('Enter an amount.');
    if (value > micro) return setNote('That’s more than you hold.');
    setNote(null);
    setReview(true);
  };

  const withdraw = async () => {
    setBusy(true);
    setNote(null);
    try {
      const p = await startUsdcSend(await access.token(), account, value);
      const signature = await access.sign(p.hash);
      await finishUsdcSend(await access.token(), p.tx, signature);
      setNote(`Sent ${formatUsdc(value)} to ${account}.`);
      setReview(false);
      setAmount('');
      setTo('');
      await read();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet glass wallet-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-head">
          <span className="usdc-coin" aria-hidden="true">
            ◎
          </span>
          <div className="sheet-title">USDC wallet</div>
          <span className="usdc-tag">Testnet: no real value</span>
          <button
            type="button"
            className="chat-close"
            aria-label="Close wallet"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="bank-card usdc-card">
          <div className="bank-balance">{wallet ? formatUsdc(micro) : '…'}</div>
          <div className="bank-sub">Yours, on NEAR. Separate from your $.</div>
        </div>
        <div className="creator-tabs" role="tablist">
          {(['deposit', 'withdraw'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'on' : ''}
              onClick={() => {
                setTab(t);
                setNote(null);
                setReview(false);
              }}
            >
              {t === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
          ))}
        </div>
        {tab === 'deposit' ? (
          <div className="wallet-pane">
            <div className="wallet-label">Your NEAR address</div>
            <div className="wallet-address">{wallet?.near ?? 'Setting up your wallet…'}</div>
            <button
              type="button"
              className="btn"
              disabled={!wallet?.near}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <div className="wallet-small">
              Send only {wallet?.token ?? 'USDC'} on NEAR to this address. Anything else won’t show
              up here. New deposits appear within a minute.
            </div>
          </div>
        ) : review ? (
          <div className="wallet-pane">
            <div className="wallet-label">You’re sending</div>
            <div className="wallet-review">{formatUsdc(value)}</div>
            <div className="wallet-label">To</div>
            <div className="wallet-address">{account}</div>
            <div className="wallet-small">This can’t be undone once it’s on the chain.</div>
            <div className="wallet-row">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void withdraw()}
              >
                {busy ? 'Sending…' : 'Confirm'}
              </button>
            </div>
          </div>
        ) : (
          <div className="wallet-pane">
            <input
              className="wallet-input"
              placeholder="NEAR account to send to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="wallet-row">
              <input
                className="wallet-input"
                placeholder="Amount in USDC"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                type="button"
                className="btn wallet-max"
                disabled={!micro}
                onClick={() => setAmount(String(micro / USDC))}
              >
                Max
              </button>
            </div>
            <button type="button" className="btn btn-primary" disabled={!micro} onClick={toReview}>
              Withdraw USDC
            </button>
          </div>
        )}
        {note && <div className="wallet-note">{note}</div>}
        {wallet?.explorer && (
          <a className="wallet-link" href={wallet.explorer} target="_blank" rel="noreferrer">
            See all activity on NearBlocks ›
          </a>
        )}
      </div>
    </div>
  );
}
