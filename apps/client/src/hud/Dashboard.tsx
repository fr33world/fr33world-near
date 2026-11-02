/**
 * The car's dashboard (owner, 2026-10-30): at the bottom middle while driving, a speedometer
 * whose needle sweeps clockwise as the car speeds up (0–260 km/h over 240°), the gear in its
 * middle (D, R, N) with the speed in figures, a fuel gauge on its left and the car's condition
 * on its right (the server's: crashes wear it down; a car park's attendant puts both right).
 */
import { DAMAGE } from '@fr33world/shared';
import type { CSSProperties } from 'react';

const MAX_KMH = 260;
/** The dial runs from 210° (bottom left) clockwise to -30° (bottom right), as cars' do. */
const START = 210;
const SWEEP = 240;

const rad = (deg: number) => (deg * Math.PI) / 180;
/** A point on a circle of radius r at `deg` (0 = right, counter-clockwise, y down). */
const at = (cx: number, cy: number, r: number, deg: number): [number, number] => [
  cx + r * Math.cos(rad(deg)),
  cy - r * Math.sin(rad(deg)),
];
const angleOf = (kmh: number) => START - (Math.min(kmh, MAX_KMH) / MAX_KMH) * SWEEP;

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = at(cx, cy, r, from);
  const [x1, y1] = at(cx, cy, r, to);
  const large = Math.abs(from - to) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

function Speedometer({ kmh, gear }: { kmh: number; gear: string }) {
  const c = 80;
  const ticks = [];
  for (let v = 0; v <= MAX_KMH; v += 10) {
    const a = angleOf(v);
    const major = v % 20 === 0;
    const [x0, y0] = at(c, c, major ? 62 : 66, a);
    const [x1, y1] = at(c, c, 72, a);
    ticks.push(
      <line
        key={v}
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke={v >= 200 ? '#ff5a52' : '#ffffff'}
        strokeOpacity={major ? 0.95 : 0.5}
        strokeWidth={major ? 2.4 : 1.2}
        strokeLinecap="round"
      />,
    );
    if (v % 40 === 0) {
      const [tx, ty] = at(c, c, 50, a);
      ticks.push(
        <text key={`t${v}`} x={tx} y={ty + 3.5} className="dash-num">
          {v}
        </text>,
      );
    }
  }
  const needle = angleOf(kmh);
  const [nx, ny] = at(c, c, 64, needle);
  const [bx, by] = at(c, c, 10, needle + 180);
  return (
    <svg viewBox="0 0 160 160" className="speedometer" aria-label={`${kmh} km/h`}>
      <circle cx={c} cy={c} r={76} fill="rgba(8,10,14,0.72)" stroke="rgba(255,255,255,0.14)" />
      <path
        d={arc(c, c, 72, START, START - SWEEP)}
        fill="none"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={3}
      />
      {/* How fast, as a lit band behind the ticks. */}
      {kmh > 1 && (
        <path
          d={arc(c, c, 72, START, needle)}
          fill="none"
          stroke="#7def06"
          strokeWidth={3}
          strokeLinecap="round"
        />
      )}
      {ticks}
      <line
        x1={bx}
        y1={by}
        x2={nx}
        y2={ny}
        stroke="#ff4d3d"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <circle cx={c} cy={c} r={6} fill="#1b1d22" stroke="#ff4d3d" strokeWidth={2} />
      <text x={c} y={c + 30} className="dash-speed">
        {kmh}
      </text>
      <text x={c} y={c + 42} className="dash-unit">
        KM/H
      </text>
      <text x={c} y={c - 22} className={`dash-gear gear-${gear}`}>
        {gear}
      </text>
    </svg>
  );
}

/** A half-dial fuel gauge, E to F, with a pump mark. */
function FuelGauge({ level }: { level: number }) {
  const c = 40;
  const a = 180 - Math.max(0, Math.min(1, level)) * 180;
  const [nx, ny] = at(c, c, 26, a);
  return (
    <svg viewBox="0 0 80 56" className="fuel" aria-label={`Fuel ${Math.round(level * 100)}%`}>
      <path
        d="M 6 40 A 34 34 0 0 1 74 40"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <path
        d={arc(c, c, 34, 180, a)}
        fill="none"
        stroke={level < 0.15 ? '#ff5a52' : '#f2c14e'}
        strokeWidth={5}
        strokeLinecap="round"
      />
      <line
        x1={c}
        y1={c}
        x2={nx}
        y2={ny}
        stroke="#ffffff"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <circle cx={c} cy={c} r={3.5} fill="#ffffff" />
      <text x={7} y={54} className="dash-unit" style={{ textAnchor: 'start' }}>
        E
      </text>
      <text x={73} y={54} className="dash-unit" style={{ textAnchor: 'end' }}>
        F
      </text>
      {/* The pump. */}
      <g transform="translate(33 18)" fill="none" stroke="#ffffff" strokeWidth={1.4} opacity={0.8}>
        <rect x={0} y={0} width={8} height={11} rx={1.2} />
        <path d="M8 3h2l1.5 2v5a1 1 0 0 1-2 0V7" />
        <line x1={1.5} y1={3} x2={6.5} y2={3} />
      </g>
    </svg>
  );
}

/** The car's condition: an engine mark, the percentage, and a bar from red to green. */
function ConditionGauge({ health, fuel }: { health: number; fuel: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, health)) * 100);
  const colour = health <= 0 ? '#ff5a52' : health < 0.45 ? '#ffb547' : '#7def06';
  const word = health <= 0 ? 'WRECKED' : fuel <= 0 ? 'NO FUEL' : `${pct}%`;
  return (
    <svg viewBox="0 0 80 56" className="fuel" aria-label={`Condition ${pct}%`}>
      {/* An engine block. */}
      <g
        transform="translate(29 6)"
        fill="none"
        stroke={colour}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d="M4 5h11l3 3h3v8h-3l-3 3H6l-2-3H1V9h3z" />
        <path d="M8 5V2h6v3" />
      </g>
      <text x={40} y={38} className="dash-num" style={{ fill: '#ffffff', fontSize: 11 }}>
        {word}
      </text>
      <rect x={10} y={44} width={60} height={5} rx={2.5} fill="rgba(255,255,255,0.18)" />
      <rect x={10} y={44} width={(60 * pct) / 100} height={5} rx={2.5} fill={colour} />
    </svg>
  );
}

export function Dashboard({
  kmh,
  gear,
  fuel,
  health,
  touch,
}: {
  kmh: number;
  gear: 'D' | 'R' | 'N';
  fuel: number;
  health: number;
  touch: boolean;
}) {
  return (
    <div className="dashboard" style={touch ? touchPlace : undefined}>
      <FuelGauge level={fuel} />
      <Speedometer kmh={kmh} gear={gear} />
      {/* Damage is off for launch: no condition to show. */}
      {DAMAGE.enabled && <ConditionGauge health={health} fuel={fuel} />}
    </div>
  );
}

/** On touch the pedals and wheel take the bottom corners: the dash sits between them. */
const touchPlace: CSSProperties = { bottom: 'max(6px, var(--safe-b))' };
