/**
 * Every modal in the game is built from these parts (owner, 2026-11-10), full screen with a
 * cancel button in the top right (owner, 2026-11-12): a dark panel with a showcase rail on the
 * left (the thing itself, large, on a lit stage), and the content on the right. Landscape first: the rail is what makes a phone's short screen still feel like a game.
 * The panel is opaque on purpose: blurring the running game behind it costs frames.
 */
import { Cancel01Icon, SquareLock02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { formatUsdc } from '@fr33world/shared';
import { type CSSProperties, type ReactNode, useEffect } from 'react';
import { formatMoney } from '../game/api.ts';
import type { Game } from '../game/Game.ts';
import { CashIcon } from './icons.tsx';
import './modal.css';

export function Ico({ icon, size = 15 }: { icon: IconSvgElement; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} />;
}

/** USDC's real mark. The figure always travels with it, or with the word (D-44). */
export const UsdcMark = ({ size = 14 }: { size?: number }) => (
  <img
    className="usdc-mark"
    src="/ui/usdc.svg"
    width={size}
    height={size}
    alt=""
    draggable={false}
  />
);

/** A medallion: one per place and faction (public/ui/medals). */
export type Medal =
  | 'police'
  | 'ems'
  | 'vipers'
  | 'kings'
  | 'gun'
  | 'dealer'
  | 'pharmacy'
  | 'shop'
  | 'parking'
  | 'guide'
  | 'settings'
  | 'desk'
  | 'black';

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');

export function Modal({
  title,
  subtitle,
  accent = '#7def06',
  medal,
  art,
  photo,
  rail,
  head,
  footer,
  size = 'md',
  className = '',
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** The modal's own colour: its light, its active tab. Green stays for the main action. */
  accent?: string;
  /** Beside the title. */
  medal?: Medal;
  /** The picture on the stage in the rail. */
  art?: string;
  /** A photo behind the rail, tinted. */
  photo?: string;
  /** Under the art, at the foot of the rail. */
  rail?: ReactNode;
  /** In the header, between the title and the close button. */
  head?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (document.pointerLockElement) void document.exitPointerLock();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Only on opening: the callers' closures change on every redraw.
  }, []);
  const hasRail = Boolean(art || rail || photo);
  return (
    <div className="m-scrim" onClick={onClose}>
      <div
        className={`m m-${size}${hasRail ? ' has-rail' : ''} ${className}`}
        style={{ '--accent': accent, '--accent-rgb': rgb(accent) } as CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {hasRail && (
          <aside className="m-rail">
            {photo && <img className="m-photo" src={photo} alt="" draggable={false} />}
            {art && (
              <div className="m-stage">
                <img className="m-art" src={art} alt="" draggable={false} />
              </div>
            )}
            {rail && <div className="m-rail-foot">{rail}</div>}
          </aside>
        )}
        <section className="m-main">
          <header className="m-head">
            {medal && (
              <img className="m-medal" src={`/ui/medals/${medal}.webp`} alt="" draggable={false} />
            )}
            <div className="m-titles">
              <h2 className="m-title">{title}</h2>
              {subtitle && <p className="m-sub">{subtitle}</p>}
            </div>
            {head}
            <button type="button" className="m-x" aria-label="Close" onClick={onClose}>
              <Ico icon={Cancel01Icon} size={20} />
            </button>
          </header>
          <div className="m-body">{children}</div>
          {footer && <footer className="m-foot">{footer}</footer>}
        </section>
      </div>
    </div>
  );
}

/** What the player has, in the header of anywhere that sells something; `dollars` where USDC isn't taken. */
export function Funds({ game, dollars = false }: { game: Game; dollars?: boolean }) {
  const { money } = game.hud;
  if (money === null && (dollars || !game.usdc)) return null;
  return (
    <div className="m-funds">
      {money !== null && (
        <span>
          <CashIcon />
          {formatMoney(money)}
        </span>
      )}
      {game.usdc && !dollars && (
        <span className="usdc">
          <UsdcMark />
          {formatUsdc(game.usdc.micro).replace(' USDC', '')}
        </span>
      )}
    </div>
  );
}

/** Something for sale or to pick: its picture on a small stage, then what it is, then the buy. */
export function Tile({
  art,
  name,
  meta,
  index = 0,
  dim = false,
  children,
}: {
  art?: string;
  name: string;
  meta?: ReactNode;
  /** Its place in the row: tiles arrive one after another. */
  index?: number;
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <article className={`m-tile${dim ? ' dim' : ''}`} style={{ '--i': index } as CSSProperties}>
      {art && (
        <div className="m-tile-stage">
          <img src={art} alt="" draggable={false} />
        </div>
      )}
      <div className="m-tile-text">
        <b>{name}</b>
        {meta && <small>{meta}</small>}
      </div>
      {children && <div className="m-tile-buy">{children}</div>}
    </article>
  );
}

/** A price you can press: `$`, or USDC with its mark. Locked, it shows a padlock. */
export function Price({
  label,
  usdc = false,
  locked = false,
  disabled = false,
  onClick,
}: {
  label: string;
  usdc?: boolean;
  locked?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`m-price${usdc ? ' usdc' : ''}`}
      disabled={locked || disabled}
      onClick={onClick}
    >
      {locked ? <Ico icon={SquareLock02Icon} size={12} /> : usdc ? <UsdcMark /> : null}
      <span>{label}</span>
    </button>
  );
}

/** What just happened, under the goods. */
export const Said = ({ text }: { text: string | null }) =>
  text ? (
    <div className="m-said" role="status">
      {text}
    </div>
  ) : null;

/** A bar with a label and a value. */
export function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: number;
  children: string;
}) {
  return (
    <div className="m-stat">
      <span>{label}</span>
      <i>
        <u style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} />
      </i>
      <b>{children}</b>
    </div>
  );
}

/** Tabs with icons, underlined in the modal's colour. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly (readonly [T, string, IconSvgElement])[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="m-tabs" role="tablist">
      {tabs.map(([t, label, icon]) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={value === t}
          className={value === t ? 'on' : ''}
          onClick={() => onChange(t)}
        >
          <Ico icon={icon} size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}
