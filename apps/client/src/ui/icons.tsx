/**
 * The game's icons: 24-unit line drawings in the current text colour, drawn for fr33world
 * (no icon library, nothing extra to download).
 */
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SitIcon = () => (
  <Icon>
    <path d="M7 4v9h9a2 2 0 0 1 2 2v5" />
    <path d="M7 13v7" />
    <path d="M7 9h7" />
  </Icon>
);

export const JumpIcon = () => (
  <Icon>
    <path d="M6 13l6-6 6 6" />
    <path d="M6 19l6-6 6 6" opacity={0.55} />
  </Icon>
);

export const PistolIcon = () => (
  <Icon>
    <path d="M3 8h16l1 2h1v3h-6l-1 2h-3l-1 4H6l1.6-7H3z" />
    <path d="M11 13h2" />
  </Icon>
);

/** A closed fist, knuckles forward. */
export const PunchIcon = () => (
  <Icon>
    <path d="M7 10V7.5a1.5 1.5 0 0 1 3 0V10" />
    <path d="M10 9.5V6.5a1.5 1.5 0 0 1 3 0v3" />
    <path d="M13 9.5V7a1.5 1.5 0 0 1 3 0v3" />
    <path d="M16 10V8.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1.5A5.5 5.5 0 0 1 6 14.5V12a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 0 3H9" />
  </Icon>
);

export const HolsterIcon = () => (
  <Icon>
    <path d="M3 8h16l1 2h1v3h-6l-1 2h-3l-1 4H6l1.6-7H3z" opacity={0.55} />
    <path d="M4 4l16 16" />
  </Icon>
);

export const FireIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Icon>
);

/** A car's door with its window: getting in or out (the touch car button). */
export const CarDoorIcon = () => (
  <Icon>
    <path d="M4 20v-9l5-6h10a1 1 0 0 1 1 1v14z" />
    <path d="M7 11l3.4-4H18v4z" />
    <path d="M14 14.5h3" />
  </Icon>
);

export const MicIcon = () => (
  <Icon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </Icon>
);

export const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const GasIcon = () => (
  <Icon>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </Icon>
);

export const BrakeIcon = () => (
  <Icon>
    <path d="M12 5v14" />
    <path d="M6 13l6 6 6-6" />
  </Icon>
);

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6" />
    <path d="M12 7.5v.5" />
  </Icon>
);

export const DoorIcon = () => (
  <Icon>
    <path d="M6 21V4h12v17" />
    <path d="M4 21h16" />
    <path d="M14.5 12.5v.5" />
  </Icon>
);

export const TalkIcon = () => (
  <Icon>
    <path d="M5 6h14v9H10l-4 3v-3H5z" />
  </Icon>
);

export const JobIcon = () => (
  <Icon>
    <path d="M4 8h16v11H4z" />
    <path d="M9 8V5h6v3" />
    <path d="M4 13h16" />
  </Icon>
);

/** A banknote, for the game's `$`. */
export const CashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 10v4M18 10v4" strokeLinecap="round" />
  </svg>
);

export const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Signal bars, for the frame rate. */
export const BarsIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="3" y="15" width="4" height="6" rx="1" />
    <rect x="10" y="10" width="4" height="11" rx="1" />
    <rect x="17" y="4" width="4" height="17" rx="1" />
  </svg>
);
