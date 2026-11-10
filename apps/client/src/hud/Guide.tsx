/**
 * The city guide, opened at the plaza's info kiosk: getting started (how to earn, cars,
 * weapons, factions), the controls (keyboard or touch), the house rules, and how to get help
 * (/help, reports from a player's card).
 */
import { ARMORY, RENTAL } from '@fr33world/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import type { Game } from '../game/Game.ts';
import {
  BookOpen01Icon,
  Car01Icon,
  CustomerSupportIcon,
  FuelStationIcon,
  GameController01Icon,
  Money03Icon,
  Shield01Icon,
  Store01Icon,
  UserGroupIcon,
  Alert02Icon,
  Target02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { Ico, Modal, Tabs } from '../ui/Modal.tsx';

type Tab = 'start' | 'controls' | 'rules' | 'help';

const ICONS: Record<string, IconSvgElement> = {
  Earn: Money03Icon,
  'Your car': Car01Icon,
  Fuel: FuelStationIcon,
  Trade: Store01Icon,
  Weapons: Target02Icon,
  Factions: UserGroupIcon,
  Trouble: Alert02Icon,
};

const START: [string, string][] = [
  ['Earn', 'Courier, mining or taxi jobs'],
  ['Your car', `Free rental for ${RENTAL.days} days, at any blue P`],
  ['Fuel', 'Blue P beside your car'],
  ['Trade', 'Phone → Market'],
  ['Weapons', `Gun Store, level ${ARMORY.licence.minLevel}+. Q draws, R reloads`],
  ['Factions', 'Apply, train, interview'],
  ['Trouble', 'Phone → 911'],
];

const KEYS: [string, string][] = [
  ['WASD', 'Move'],
  ['Shift', 'Walk'],
  ['Space', 'Jump / handbrake'],
  ['H', 'Horn'],
  ['E', 'Use / car'],
  ['Click', 'Punch'],
  ['V', 'Talk'],
  ['T', 'Chat'],
  ['G', 'Emotes'],
  ['P', 'Phone'],
  ['B', 'Bag'],
  ['Q · R', 'Weapon · reload'],
];

const TOUCH: [string, string][] = [
  ['Left', 'Move'],
  ['Right', 'Look'],
  ['Pinch', 'Zoom'],
  ['Mic', 'Hold to talk'],
  ['Car', 'Arrows and pedals'],
];

const RULES: [string, string][] = [
  ['Stay in character', 'It’s a role-play city'],
  ['No RDM', 'No attacks without a reason'],
  ['No VDM', 'No cars as weapons'],
  ['Respect', 'No hate or harassment'],
  ['No cheats', 'Report bugs'],
  ['Admins', 'Their call stands'],
];

const HELP: [string, string][] = [
  ['/help', 'Calls an admin'],
  ['Report', 'Tap a name tag'],
  ['/commands', 'All commands'],
];

export function Guide({ game, touch }: { game: Game; touch: boolean }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('start');

  useEffect(() => {
    game.onGuide = () => {
      if (document.pointerLockElement) void document.exitPointerLock();
      setOpen(true);
    };
    return () => {
      game.onGuide = () => {};
    };
  }, [game]);

  if (!open) return null;
  const rows: [string, string][] =
    tab === 'start'
      ? START
      : tab === 'controls'
        ? touch
          ? TOUCH
          : KEYS
        : tab === 'rules'
          ? RULES
          : HELP;
  return (
    <Modal
      title="City guide"
      accent="#7def06"
      size="lg"
      art="/ui/medals/guide.webp"
      onClose={() => setOpen(false)}
    >
      <Tabs
        tabs={
          [
            ['start', 'Start', BookOpen01Icon],
            ['controls', 'Controls', GameController01Icon],
            ['rules', 'Rules', Shield01Icon],
            ['help', 'Help', CustomerSupportIcon],
          ] as const
        }
        value={tab}
        onChange={setTab}
      />
      <dl className="m-facts">
        {rows.map(([k, v], i) => (
          <div key={k} style={{ '--i': i } as CSSProperties}>
            {ICONS[k] && (
              <span className="m-fact-ico">
                <Ico icon={ICONS[k]} size={13} />
              </span>
            )}
            <span>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </span>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
