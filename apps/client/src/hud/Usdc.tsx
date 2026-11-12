/**
 * USDC (Phase 17; D-44): real money, kept visibly apart from the game's `$`, with its own blue
 * mark and word. The top bar shows the balance, read from the chain, and a tap on it opens the
 * wallet: deposit, withdraw, and the record on the chain. Withdrawing is signed on this device,
 * so the game can't move a player's USDC for them. Nothing here turns `$` into USDC or back.
 */
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  Copy01Icon,
  DropletIcon,
  LinkSquare02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { formatUsdc, USDC } from '@fr33world/shared';
import { useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import { claimTestUsdc, fetchTestUsdc, finishUsdcSend, startUsdcSend } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { Ico, Modal, Tabs, UsdcMark } from '../ui/Modal.tsx';

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
      <UsdcMark size={20} />
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
        <UsdcMark size={18} />
        <div className="bank-name">USDC wallet</div>
        <span className="usdc-tag">Testnet</span>
      </div>
      <div className="bank-balance">{game.usdc ? formatUsdc(game.usdc.micro) : '…'}</div>
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
  /** The testnet faucet: null until asked, or where there's none. */
  const [faucet, setFaucet] = useState<{ micro: number; refused: string | null } | null>(null);
  const access = game.usdcAccess();

  const read = async (link = false) => {
    try {
      await game.refreshUsdc(link);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'The wallet didn’t answer. Try again.');
    }
  };

  const checkFaucet = async () => {
    const a = game.usdcAccess();
    if (!a) return;
    try {
      const f = await fetchTestUsdc(await a.token());
      setFaucet(f.micro > 0 ? f : null);
    } catch {
      setFaucet(null);
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
      void read(true).then(checkFaucet);
    };
    return () => {
      game.onWallet = () => {};
    };
  }, [game]);

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
      setNote('Couldn’t copy.');
    }
  };

  const claim = async () => {
    if (!access) return;
    setBusy(true);
    setNote(null);
    try {
      const got = await claimTestUsdc(await access.token());
      setNote(`${figure(got.micro)} test USDC is in your wallet.`);
      await read();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'The faucet didn’t answer. Try again.');
    } finally {
      setBusy(false);
      void checkFaucet();
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
    <Modal
      title="USDC wallet"
      accent="#4f9cf0"
      art="/ui/usdc.webp"
      className="m-wallet"
      rail={
        <>
          <div className="w-balance">{wallet ? figure(micro) : '…'}</div>
          <div className="w-unit">USDC</div>
          <span className="w-testnet">Testnet</span>
        </>
      }
      footer={
        wallet?.explorer ? (
          <a className="w-link" href={wallet.explorer} target="_blank" rel="noreferrer">
            Activity <Ico icon={LinkSquare02Icon} size={12} />
          </a>
        ) : undefined
      }
      onClose={() => setOpen(false)}
    >
      <Tabs
        tabs={
          [
            ['deposit', 'Deposit', ArrowDown02Icon],
            ['withdraw', 'Withdraw', ArrowUp02Icon],
          ] as const
        }
        value={tab}
        onChange={(t) => {
          setTab(t);
          setNote(null);
          setReview(false);
        }}
      />
      {tab === 'deposit' ? (
        <div className="w-deposit">
          <div className="w-qr">
            {wallet?.near ? <DepositQr value={wallet.near} /> : <span>Setting up…</span>}
          </div>
          <div className="w-pane">
            <label className="w-label">NEAR address</label>
            <div className="w-address">{wallet?.near ?? 'Setting up…'}</div>
            <button
              type="button"
              className={`m-btn small${copied ? ' done' : ''}`}
              disabled={!wallet?.near}
              onClick={() => void copy()}
            >
              <Ico icon={copied ? Tick02Icon : Copy01Icon} size={13} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <p className="w-fine">
              Only <b>{wallet?.token ?? 'USDC'}</b> on NEAR.
            </p>
            {faucet && (
              <div className="w-faucet">
                <button
                  type="button"
                  className="m-btn small go"
                  disabled={busy || faucet.refused !== null}
                  onClick={() => void claim()}
                >
                  <Ico icon={DropletIcon} size={13} />
                  {busy ? 'Asking…' : `Get ${figure(faucet.micro)} test USDC`}
                </button>
                <p className="w-fine">
                  {faucet.refused ?? 'Free from the testnet faucet, once a day.'}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : review ? (
        <div className="w-pane w-review">
          <label className="w-label">You’re sending</label>
          <div className="w-amount">
            <UsdcMark size={18} />
            {formatUsdc(value)}
          </div>
          <label className="w-label">To</label>
          <div className="w-address">{account}</div>
          <p className="w-fine">Can’t be undone.</p>
          <div className="m-actions">
            <button
              type="button"
              className="m-btn"
              disabled={busy}
              onClick={() => setReview(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="m-btn go"
              disabled={busy}
              onClick={() => void withdraw()}
            >
              {busy ? 'Sending…' : 'Confirm'}
            </button>
          </div>
        </div>
      ) : (
        <div className="w-pane">
          <label className="w-label">Send to</label>
          <input
            className="m-input"
            placeholder="NEAR account"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <label className="w-label">Amount</label>
          <div className="w-amount-row">
            <input
              className="m-input"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className="m-btn small"
              disabled={!micro}
              onClick={() => setAmount(String(micro / USDC))}
            >
              Max
            </button>
          </div>
          <button type="button" className="m-btn go" disabled={!micro} onClick={toReview}>
            Withdraw USDC
          </button>
        </div>
      )}
      {note && <div className="m-said">{note}</div>}
    </Modal>
  );
}

/**
 * The deposit address as a QR code. Rounded modules and eyes in the wallet's navy, with USDC's mark
 * in the middle: the highest error correction leaves room for it and still scans.
 */
function DepositQr({ value }: { value: string }) {
  const { size, dots } = useMemo(() => {
    const qr = encode(value, { ecc: 'H', border: 0 });
    const n = qr.size;
    const eye = (x: number, y: number) =>
      (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    const mid = (n - 1) / 2;
    let d = '';
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1) {
        if (!qr.data[y]?.[x] || eye(x, y) || Math.hypot(x - mid, y - mid) < n * 0.17) continue;
        d += `M${x + 0.3} ${y}h.4a.3.3 0 0 1 .3.3v.4a.3.3 0 0 1-.3.3h-.4a.3.3 0 0 1-.3-.3v-.4a.3.3 0 0 1 .3-.3z`;
      }
    return { size: n, dots: d };
  }, [value]);
  const eyes = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const;
  const logo = size * 0.27;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of your NEAR address">
      <path d={dots} fill="#0a1a3a" />
      {eyes.map(([x, y]) => (
        <g key={`${x}-${y}`} fill="#0a1a3a">
          <path
            fillRule="evenodd"
            d={`M${x + 1.6} ${y}h3.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6h-3.8a1.6 1.6 0 0 1-1.6-1.6v-3.8a1.6 1.6 0 0 1 1.6-1.6zM${x + 1.9} ${y + 1}a.9.9 0 0 0-.9.9v3.2a.9.9 0 0 0 .9.9h3.2a.9.9 0 0 0 .9-.9v-3.2a.9.9 0 0 0-.9-.9z`}
          />
          <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.7} fill="#2775ca" />
        </g>
      ))}
      <image
        href="/ui/usdc.svg"
        x={(size - logo) / 2}
        y={(size - logo) / 2}
        width={logo}
        height={logo}
      />
    </svg>
  );
}
