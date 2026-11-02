/**
 * The map (owner, 2026-10-29/30, after OneState's HUD): a minimap at the top left that turns
 * with the camera, and on a tap the whole island, north up. The picture is the city itself
 * seen from straight above (public/map/island.webp, drawn by scripts/map-image.mjs from the
 * game); over it the game draws the district names, symbols for the landmarks, other players
 * as dots and the player's arrow, so they stay sharp at any size.
 */
import { type CityLayout, HARBOUR, LAKE, PIER, QUARRY, WORLD } from '@fr33world/city';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Game } from '../game/Game.ts';

/** How much of the city the minimap shows across (m). */
const MINI_SPAN = 320;
const SPAN = WORLD.x1 - WORLD.x0;

let picture: HTMLImageElement | null = null;
function islandPicture(): HTMLImageElement {
  if (!picture) {
    picture = new Image();
    picture.src = '/map/island.webp';
  }
  return picture;
}

type Icon =
  | 'stadium'
  | 'hall'
  | 'scope'
  | 'lake'
  | 'wheel'
  | 'anchor'
  | 'pick'
  | 'park'
  | 'cross'
  | 'dollar'
  | 'police'
  | 'gang';

/** A place on the map: a district's name, or a landmark with its symbol. */
interface Place {
  x: number;
  z: number;
  name: string;
  icon?: Icon;
}

const middle = (r: { x0: number; z0: number; x1: number; z1: number }) => ({
  x: (r.x0 + r.x1) / 2,
  z: (r.z0 + r.z1) / 2,
});

function places(layout: CityLayout): Place[] {
  const l = layout.landmarks;
  const pier = PIER[0];
  return [
    { ...middle({ x0: -336, z0: -576, x1: 560, z1: 104 }), name: 'Downtown' },
    { ...middle({ x0: -336, z0: 104, x1: 624, z1: 704 }), name: 'Arts District' },
    { ...middle({ x0: -936, z0: 24, x1: -336, z1: 704 }), name: 'Mid City' },
    { ...middle({ x0: -936, z0: -840, x1: -336, z1: 24 }), name: 'Palm Heights' },
    { ...middle({ x0: -936, z0: 704, x1: 624, z1: 1536 }), name: 'South Grid' },
    { ...middle({ x0: 700, z0: -840, x1: 1536, z1: 64 }), name: 'Eastside' },
    { ...middle({ x0: 700, z0: 64, x1: 1536, z1: 1300 }), name: 'Port' },
    { x: 0, z: -1080, name: 'Los Soles Hills' },
    { x: -1250, z: 300, name: 'Beach' },
    { x: l.stadium.x, z: l.stadium.z, name: 'Stadium', icon: 'stadium' },
    { x: l.cityHall.x, z: l.cityHall.z, name: 'City Hall', icon: 'hall' },
    { x: l.observatory.x, z: l.observatory.z, name: 'Observatory', icon: 'scope' },
    { x: LAKE.x, z: LAKE.z, name: 'Lake', icon: 'lake' },
    ...(pier ? [{ ...middle(pier), name: 'Pier', icon: 'wheel' as const }] : []),
    { ...middle(QUARRY), name: 'Quarry', icon: 'pick' },
    { ...middle(layout.plaza), name: 'Plaza', icon: 'park' },
    { ...middle(HARBOUR), name: 'Harbour', icon: 'anchor' },
    { x: 1024, z: -56, name: 'Medical Center' },
    ...layout.points.flatMap((p): Place[] =>
      p.kind === 'entrance'
        ? [
            {
              x: p.x,
              z: p.z,
              name: p.name ?? '',
              icon: p.service === 'hospital' ? 'cross' : p.service === 'police' ? 'police' : 'gang',
            },
          ]
        : [],
    ),
    ...(layout.dealership
      ? [
          {
            ...middle(layout.dealership.rect),
            name: layout.dealership.name,
            icon: 'dollar' as const,
          },
        ]
      : []),
  ];
}

/** Draws a landmark's symbol in a round badge at (x, y), `r` its radius. */
function badge(g: CanvasRenderingContext2D, icon: Icon, x: number, y: number, r: number) {
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(12, 14, 18, 0.82)';
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = r * 0.12;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.strokeStyle =
    icon === 'cross'
      ? '#ff5a52'
      : icon === 'dollar'
        ? '#ffbf3a'
        : icon === 'police'
          ? '#6fb1ff'
          : icon === 'gang'
            ? '#37d67a'
            : '#ffffff';
  g.lineWidth = r * 0.16;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const s = r * 0.5;
  g.beginPath();
  switch (icon) {
    case 'stadium':
      g.ellipse(0, 0, s, s * 0.65, 0, 0, Math.PI * 2);
      g.moveTo(s * 0.45, 0);
      g.ellipse(0, 0, s * 0.45, s * 0.28, 0, 0, Math.PI * 2);
      break;
    case 'hall':
      g.moveTo(-s, s * 0.8);
      g.lineTo(s, s * 0.8);
      for (const cx of [-0.6, 0, 0.6]) {
        g.moveTo(cx * s, s * 0.8);
        g.lineTo(cx * s, -s * 0.1);
      }
      g.moveTo(-s, -s * 0.2);
      g.lineTo(0, -s);
      g.lineTo(s, -s * 0.2);
      break;
    case 'scope':
      g.arc(0, s * 0.2, s * 0.85, Math.PI, 0);
      g.closePath();
      g.moveTo(-s * 0.2, -s * 0.2);
      g.lineTo(s * 0.7, -s * 0.9);
      break;
    case 'lake':
      for (const dy of [-0.35, 0.35]) {
        g.moveTo(-s, dy * s);
        g.bezierCurveTo(-s * 0.5, (dy - 0.4) * s, 0, (dy + 0.4) * s, s, dy * s);
      }
      break;
    case 'wheel':
      g.arc(0, 0, s * 0.85, 0, Math.PI * 2);
      for (let k = 0; k < 4; k += 1) {
        const a = (k / 4) * Math.PI;
        g.moveTo(Math.cos(a) * s * 0.85, Math.sin(a) * s * 0.85);
        g.lineTo(-Math.cos(a) * s * 0.85, -Math.sin(a) * s * 0.85);
      }
      break;
    case 'anchor':
      g.moveTo(0, -s);
      g.lineTo(0, s * 0.9);
      g.moveTo(-s * 0.5, -s * 0.4);
      g.lineTo(s * 0.5, -s * 0.4);
      g.moveTo(-s * 0.85, s * 0.2);
      g.quadraticCurveTo(-s * 0.7, s * 0.95, 0, s * 0.9);
      g.quadraticCurveTo(s * 0.7, s * 0.95, s * 0.85, s * 0.2);
      break;
    case 'pick':
      g.moveTo(-s * 0.7, s * 0.8);
      g.lineTo(s * 0.5, -s * 0.4);
      g.moveTo(-s * 0.1, -s * 0.9);
      g.quadraticCurveTo(s * 0.9, -s * 0.9, s * 0.9, s * 0.1);
      break;
    case 'park':
      g.arc(0, -s * 0.25, s * 0.55, 0, Math.PI * 2);
      g.moveTo(0, s * 0.3);
      g.lineTo(0, s * 0.95);
      break;
    case 'police':
      // A shield.
      g.moveTo(-s * 0.7, -s * 0.7);
      g.lineTo(s * 0.7, -s * 0.7);
      g.lineTo(s * 0.7, s * 0.1);
      g.lineTo(0, s * 0.85);
      g.lineTo(-s * 0.7, s * 0.1);
      g.closePath();
      break;
    case 'gang':
      // A crown.
      g.moveTo(-s * 0.75, s * 0.6);
      g.lineTo(-s * 0.75, -s * 0.5);
      g.lineTo(-s * 0.3, 0);
      g.lineTo(0, -s * 0.7);
      g.lineTo(s * 0.3, 0);
      g.lineTo(s * 0.75, -s * 0.5);
      g.lineTo(s * 0.75, s * 0.6);
      g.closePath();
      break;
    case 'cross':
      g.lineWidth = r * 0.28;
      g.moveTo(0, -s * 0.75);
      g.lineTo(0, s * 0.75);
      g.moveTo(-s * 0.75, 0);
      g.lineTo(s * 0.75, 0);
      break;
    case 'dollar':
      // An S with a bar through it.
      g.moveTo(s * 0.55, -s * 0.5);
      g.bezierCurveTo(s * 0.3, -s * 0.85, -s * 0.6, -s * 0.75, -s * 0.5, -s * 0.25);
      g.bezierCurveTo(-s * 0.4, s * 0.15, s * 0.6, -s * 0.05, s * 0.5, s * 0.35);
      g.bezierCurveTo(s * 0.45, s * 0.8, -s * 0.35, s * 0.85, -s * 0.55, s * 0.5);
      g.moveTo(0, -s * 1);
      g.lineTo(0, s * 1);
      break;
  }
  g.stroke();
  g.restore();
}

/** A label: white type with a dark halo, legible over any part of the picture. */
function label(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  district: boolean,
) {
  const shown = district ? text.toUpperCase() : text;
  g.font = district ? `400 ${px}px 'Bebas Neue', sans-serif` : `700 ${px}px Barlow, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(8, 10, 14, 0.8)';
  g.lineWidth = px * 0.28;
  g.strokeText(shown, x, y);
  g.fillStyle = district ? 'rgba(255, 255, 255, 0.92)' : '#ffffff';
  g.fillText(shown, x, y);
}

/** The player's arrow, pointing up (`angle` turns it). */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, s: number) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s * 0.72, s * 0.8);
  g.lineTo(0, s * 0.38);
  g.lineTo(-s * 0.72, s * 0.8);
  g.closePath();
  g.fillStyle = '#7def06';
  g.strokeStyle = '#0a0f02';
  g.lineWidth = 2;
  g.stroke();
  g.fill();
  g.restore();
}

/** The waypoint's route as a line, and a pin on its destination (`at` maps world to canvas). */
function drawRoute(
  g: CanvasRenderingContext2D,
  game: Game,
  at: (x: number, z: number) => [number, number],
  width: number,
  pin: number,
) {
  const w = game.waypoints;
  if (!w.target) return;
  const pts = w.route?.points ?? [];
  if (pts.length > 1) {
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const [colour, lw] of [
      ['rgba(10, 15, 2, 0.75)', width + 3],
      ['#7def06', width],
    ] as const) {
      g.strokeStyle = colour;
      g.lineWidth = lw;
      g.beginPath();
      pts.forEach(([x, z], i) => {
        const [sx, sy] = at(x, z);
        if (i === 0) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      });
      g.stroke();
    }
  }
  const [px, py] = at(w.target.x, w.target.z);
  g.fillStyle = '#7def06';
  g.strokeStyle = '#0a0f02';
  g.lineWidth = Math.max(2, pin / 4);
  g.beginPath();
  g.arc(px, py - pin, pin * 0.75, Math.PI * 0.85, Math.PI * 2.15);
  g.lineTo(px, py);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#0a0f02';
  g.beginPath();
  g.arc(px, py - pin, pin * 0.28, 0, Math.PI * 2);
  g.fill();
}

function others(game: Game): { x: number; z: number }[] {
  return [...game.remote.bodies.values()].map((b) => ({ x: b.pos.x, z: b.pos.z }));
}

export function Minimap({ game, size }: { game: Game; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio);
    canvas.width = canvas.height = Math.round(size * dpr);
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    const map = islandPicture();
    const spots = places(game.layout).filter((p) => p.icon);
    let frame = 0;
    let last = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      // A dozen times a second is plenty for a map.
      if (now - last < 80) return;
      last = now;
      const at = game.whereabouts();
      if (!at || !map.complete || map.naturalWidth === 0) return;
      const w = canvas.width;
      // Map pixels per metre, and screen pixels per metre.
      const ppm = map.naturalWidth / SPAN;
      const scale = w / MINI_SPAN;
      const turn = at.yaw + Math.PI;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#5fb3d9';
      g.fillRect(0, 0, w, w);
      // Turned so the camera's direction is up (yaw 0 looks towards +z).
      g.translate(w / 2, w / 2);
      g.rotate(turn);
      g.scale(scale / ppm, scale / ppm);
      g.drawImage(map, -(at.x - WORLD.x0) * ppm, -(at.z - WORLD.z0) * ppm);
      g.setTransform(1, 0, 0, 1, 0, 0);
      // Landmarks and players, placed by the same turn but drawn upright.
      const toScreen = (x: number, z: number): [number, number] => {
        const dx = (x - at.x) * scale;
        const dz = (z - at.z) * scale;
        return [
          w / 2 + dx * Math.cos(turn) - dz * Math.sin(turn),
          w / 2 + dx * Math.sin(turn) + dz * Math.cos(turn),
        ];
      };
      for (const p of spots) {
        const [x, y] = toScreen(p.x, p.z);
        if (p.icon && x > -20 && y > -20 && x < w + 20 && y < w + 20)
          badge(g, p.icon, x, y, 9 * dpr);
      }
      drawRoute(g, game, toScreen, 4 * dpr, 9 * dpr);
      g.fillStyle = '#ffffff';
      for (const o of others(game)) {
        const [x, y] = toScreen(o.x, o.z);
        g.beginPath();
        g.arc(x, y, 3.2 * dpr, 0, Math.PI * 2);
        g.fill();
      }
      arrow(g, w / 2, w / 2, 0, w * 0.06);
      // North, on the rim.
      const r = w / 2 - 11 * dpr;
      const nx = w / 2 - Math.sin(at.yaw) * r;
      const ny = w / 2 + Math.cos(at.yaw) * r;
      g.font = `800 ${11 * dpr}px Barlow, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(10, 12, 16, 0.75)';
      g.beginPath();
      g.arc(nx, ny, 8 * dpr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillText('N', nx, ny + 0.5 * dpr);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [game, size]);

  return (
    <>
      <button
        type="button"
        className="minimap glass"
        aria-label="Open the map"
        style={{ width: size, height: size }}
        onClick={() => {
          game.note('map');
          setOpen(true);
        }}
      >
        <canvas ref={ref} />
      </button>
      {/* On the page itself: inside the HUD's corner (which lets taps through to the game),
          its buttons took no taps, so Close did nothing. */}
      {open && createPortal(<BigMap game={game} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** A place the map lists, to be guided to. */
export interface Listed {
  name: string;
  x: number;
  z: number;
  kind: string;
}

/** Landmarks, then the places to work and the city guide (city points). */
export function listed(game: Game): Listed[] {
  const out: Listed[] = places(game.layout)
    .filter((p) => p.icon)
    .map((p) => ({ name: p.name, x: p.x, z: p.z, kind: 'Landmark' }));
  const KIND: Record<string, string> = {
    depot: 'Courier jobs',
    quarry_office: 'Mining jobs',
    buyer: 'Ore buyer',
    info: 'City guide',
    parking: 'Parking',
    gunstore: 'Gun store',
    taxi_depot: 'Taxi jobs',
  };
  for (const p of game.layout.points)
    if (KIND[p.kind])
      out.push({ name: p.name ?? KIND[p.kind] ?? '', x: p.x, z: p.z, kind: KIND[p.kind] ?? '' });
  return out;
}

/**
 * The whole island, north up (owner, 2026-10-30: zoom, and a list of places): pinch, the wheel
 * or the buttons zoom from the whole island down to the streets; drag to pan; tap a place to
 * set a waypoint there (tap it again to clear). On the right, the places: tap one to centre
 * the map on it and be guided there.
 */
function BigMap({ game, onClose }: { game: Game; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  /** The view: the centre (m) and the zoom (screen px per metre, before the pixel ratio). */
  const view = useRef({ cx: (WORLD.x0 + WORLD.x1) / 2, cz: (WORLD.z0 + WORLD.z1) / 2, zoom: 0 });
  const draw = useRef<() => void>(() => {});
  const [, setTick] = useState(0);
  const list = useRef<Listed[]>(listed(game));

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const map = islandPicture();
    const g = canvas.getContext('2d') as CanvasRenderingContext2D;
    const dpr = Math.min(2, window.devicePixelRatio);
    const all = places(game.layout);
    const at = game.whereabouts();
    let timer = 0;
    let queued = 0;
    const fit = () => Math.min(canvas.clientWidth, canvas.clientHeight) / SPAN;
    const render = () => {
      queued = 0;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const v = view.current;
      if (v.zoom === 0) {
        v.zoom = fit();
        if (at) {
          v.cx = at.x;
          v.cz = at.z;
          v.zoom = fit() * 2.2;
        }
      }
      const k = v.zoom * dpr;
      const X = (x: number) => (x - v.cx) * k + w / 2;
      const Z = (z: number) => (z - v.cz) * k + h / 2;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#5fb3d9';
      g.fillRect(0, 0, w, h);
      if (map.complete && map.naturalWidth > 0)
        g.drawImage(map, X(WORLD.x0), Z(WORLD.z0), SPAN * k, SPAN * k);
      const zoomedIn = v.zoom > fit() * 1.6;
      if (!zoomedIn)
        for (const p of all) if (!p.icon) label(g, p.name, X(p.x), Z(p.z), 22 * dpr, true);
      for (const p of all) {
        if (!p.icon) continue;
        badge(g, p.icon, X(p.x), Z(p.z), 11 * dpr);
        label(g, p.name, X(p.x), Z(p.z) + 22 * dpr, 12 * dpr, false);
      }
      // Work places and parking, as small pins once zoomed in a little.
      if (v.zoom > fit() * 1.3)
        for (const p of list.current)
          if (p.kind !== 'Landmark') {
            g.fillStyle = p.kind === 'Parking' ? '#2f7bff' : '#7def06';
            g.beginPath();
            g.arc(X(p.x), Z(p.z), 5 * dpr, 0, Math.PI * 2);
            g.fill();
            g.lineWidth = 1.5 * dpr;
            g.strokeStyle = '#0a0f02';
            g.stroke();
          }
      drawRoute(g, game, (x, z) => [X(x), Z(z)], 4 * dpr, 11 * dpr);
      g.fillStyle = '#ffffff';
      for (const o of others(game)) {
        g.beginPath();
        g.arc(X(o.x), Z(o.z), 3.5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
      const me = game.whereabouts();
      // Facing: yaw 0 looks towards +z, which is down on a north-up map.
      if (me) arrow(g, X(me.x), Z(me.z), Math.PI - me.yaw, 12 * dpr);
    };
    draw.current = () => {
      if (!queued) queued = requestAnimationFrame(render);
    };
    const loop = () => {
      draw.current();
      timer = window.setTimeout(loop, map.complete ? 300 : 80);
    };
    loop();
    const onResize = () => draw.current();
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(queued);
      window.removeEventListener('resize', onResize);
    };
  }, [game]);

  /** Zooms by `factor` about a point on the canvas (px from its top left). */
  const zoomAt = (factor: number, px?: number, py?: number) => {
    const canvas = ref.current;
    if (!canvas) return;
    const v = view.current;
    const fit = Math.min(canvas.clientWidth, canvas.clientHeight) / SPAN;
    const next = Math.max(fit, Math.min(4, v.zoom * factor));
    const ox = (px ?? canvas.clientWidth / 2) - canvas.clientWidth / 2;
    const oy = (py ?? canvas.clientHeight / 2) - canvas.clientHeight / 2;
    // Keep the point under the finger where it is.
    v.cx += ox / v.zoom - ox / next;
    v.cz += oy / v.zoom - oy / next;
    v.zoom = next;
    draw.current();
  };

  // Pointers: one drags, two pinch; a short tap sets a waypoint.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(0);
  const pinch = useRef(0);

  const place = (p: Listed) => {
    view.current.cx = p.x;
    view.current.cz = p.z;
    const canvas = ref.current;
    if (canvas)
      view.current.zoom = Math.max(
        view.current.zoom,
        (Math.min(canvas.clientWidth, canvas.clientHeight) / SPAN) * 3,
      );
    game.waypoints.set({ x: p.x, z: p.z, label: p.name, by: 'map' });
    draw.current();
    setTick((n) => n + 1);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="bigmap glass" onClick={(e) => e.stopPropagation()}>
        <div className="bigmap-head">
          <span className="sheet-title">Los Soles</span>
          <span className="bigmap-hint">
            {game.waypoints.target
              ? `Route to ${game.waypoints.target.label}`
              : 'Tap the map or a place to set a route'}
          </span>
          <button type="button" className="btn btn-link" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="bigmap-body">
          <div className="bigmap-view">
            <canvas
              ref={ref}
              onWheel={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                moved.current = 0;
                pinch.current = 0;
              }}
              onPointerMove={(e) => {
                const ps = pointers.current;
                const was = ps.get(e.pointerId);
                if (!was) return;
                const now = { x: e.clientX, y: e.clientY };
                if (ps.size >= 2) {
                  const [a, b] = [...ps.values()] as [
                    { x: number; y: number },
                    { x: number; y: number },
                  ];
                  const before = Math.hypot(a.x - b.x, a.y - b.y);
                  ps.set(e.pointerId, now);
                  const [c, d] = [...ps.values()] as [
                    { x: number; y: number },
                    { x: number; y: number },
                  ];
                  const after = Math.hypot(c.x - d.x, c.y - d.y);
                  const r = e.currentTarget.getBoundingClientRect();
                  if (before > 0)
                    zoomAt(after / before, (c.x + d.x) / 2 - r.left, (c.y + d.y) / 2 - r.top);
                  moved.current += 99;
                  pinch.current = 1;
                  return;
                }
                const v = view.current;
                v.cx -= (now.x - was.x) / v.zoom;
                v.cz -= (now.y - was.y) / v.zoom;
                moved.current += Math.hypot(now.x - was.x, now.y - was.y);
                ps.set(e.pointerId, now);
                draw.current();
              }}
              onPointerUp={(e) => {
                pointers.current.delete(e.pointerId);
                if (moved.current > 8 || pinch.current) return;
                // A tap: a waypoint there (or, on the mark, clear it).
                const r = e.currentTarget.getBoundingClientRect();
                const v = view.current;
                const x = v.cx + (e.clientX - r.left - r.width / 2) / v.zoom;
                const z = v.cz + (e.clientY - r.top - r.height / 2) / v.zoom;
                const t = game.waypoints.target;
                if (t?.by === 'map' && Math.hypot(t.x - x, t.z - z) < 14 / v.zoom)
                  game.waypoints.clear();
                else if (!t || t.by === 'map')
                  game.waypoints.set({ x, z, label: 'Marked spot', by: 'map' });
                draw.current();
                setTick((n) => n + 1);
              }}
              onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
            />
            <div className="bigmap-zoom">
              <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.6)}>
                +
              </button>
              <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.6)}>
                −
              </button>
            </div>
          </div>
          <div className="bigmap-list">
            {list.current.map((p) => (
              <button
                key={`${p.name}${p.x}`}
                type="button"
                className="bigmap-place"
                onClick={() => place(p)}
              >
                <PinIcon />
                <span>
                  <b>{p.name}</b>
                  <small>{p.kind}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 2.5a7 7 0 0 0-7 7c0 5 7 12 7 12s7-7 7-12a7 7 0 0 0-7-7z" fill="#7def06" />
      <circle cx="12" cy="9.5" r="2.6" fill="#0a0f02" />
    </svg>
  );
}
