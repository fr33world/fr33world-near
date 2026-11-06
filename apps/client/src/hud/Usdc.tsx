/**
 * The USDC wallet card (Phase 17; D-44): real money, kept visibly apart from the game's `$`. It
 * has its own blue card, mark and label. The balance is read from the chain; sending is signed on
 * this device, so the game can't move a player's USDC for them.
 */
import { formatUsdc, USDC } from '@fr33world/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchUsdc, finishUsdcSend, linkUsdc, startUsdcSend } from '../game/api.ts';
import type { Game } from '../game/Game.ts';

export function UsdcCard({ game }: { game: Game }) {
  const access = game.usdcAccess();
  const [near, setNear] = useState<string | null>(null);
  const [micro, setMicro] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!access) return;
    const token = await access.token();
    let w = await fetchUsdc(token);
    if (!w.near) {
      await linkUsdc(token);
      w = await fetchUsdc(token);
    }
    setNear(w.near);
    setMicro(w.micro);
  }, [access]);

  useEffect(() => {
    load().catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
    // Once, when the card opens.
  }, []);

  if (!access) return null;

  const send = async () => {
    const value = Math.round(Number(amount) * USDC);
    if (!Number.isFinite(value) || value <= 0) return setNote('Enter an amount.');
    setBusy(true);
    setNote(null);
    try {
      const token = await access.token();
      const p = await startUsdcSend(token, to.trim(), value);
      const signature = await access.sign(p.hash);
      await finishUsdcSend(await access.token(), p.tx, signature);
      setNote('Sent.');
      setSending(false);
      setAmount('');
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That didn’t go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bank-card usdc-card">
      <div className="usdc-head">
        <span className="usdc-mark" aria-hidden="true">
          ◎
        </span>
        <div className="bank-name">USDC wallet</div>
        <span className="usdc-tag">Testnet: no real value</span>
      </div>
      <div className="bank-balance">{micro === null ? '…' : formatUsdc(micro)}</div>
      <div className="bank-sub">Yours, on NEAR. Separate from your $.</div>
      {near && (
        <div className="usdc-address" title={near}>
          {near.slice(0, 10)}…{near.slice(-6)}
        </div>
      )}
      {sending ? (
        <div className="usdc-send">
          <input
            placeholder="NEAR account"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoCapitalize="off"
            spellCheck={false}
          />
          <input
            placeholder="USDC"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Send USDC'}
          </button>
        </div>
      ) : (
        <button type="button" className="btn" disabled={!micro} onClick={() => setSending(true)}>
          Send USDC
        </button>
      )}
      {note && <div className="bank-sub">{note}</div>}
    </div>
  );
}
