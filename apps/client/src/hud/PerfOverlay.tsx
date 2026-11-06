import { useEffect, useState } from 'react';
import type { Game } from '../game/Game.ts';

/** Prototype measurement overlay (technical-plan §13 item 8). Hide with ?perf=0. */
export function PerfOverlay({
  game,
  wallet = null,
}: {
  game: Game;
  /** The account's NEAR wallet, shortened. */
  wallet?: string | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  if (new URLSearchParams(location.search).get('perf') === '0') return null;
  const s = game.stats;
  return (
    <div
      style={{
        position: 'fixed',
        // Below the settings gear.
        top: 'calc(var(--safe-t) + 54px)',
        right: 'var(--safe-r)',
        padding: '6px 10px',
        borderRadius: 8,
        background: 'rgba(8, 10, 14, 0.62)',
        color: '#e8ecf1',
        font: '600 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {`${game.hud.clock}  ${s.tier}${s.resolution < 100 ? ` ${s.resolution}%` : ''}
${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms
${s.drawCalls} calls  ${(s.triangles / 1000).toFixed(0)}k tris
${s.geometries} geo  ${s.textures} tex${s.heapMB ? `  ${s.heapMB.toFixed(0)} MB` : ''}
${game.hud.net}${game.net.connected ? `  ${game.hud.ping} ms  ${game.hud.nearby} near` : ''}${wallet ? `\nwallet ${wallet.slice(0, 4)}…${wallet.slice(-4)}` : ''}`}
    </div>
  );
}
