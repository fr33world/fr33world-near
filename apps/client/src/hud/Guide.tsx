/**
 * The city guide, opened at the plaza's info kiosk: getting started (how to earn, cars,
 * weapons, factions), the controls (keyboard or touch), the house rules, and how to get help
 * (/help, reports from a player's card).
 */
import { ARMORY, RENTAL } from '@fr33world/shared';
import { useEffect, useState } from 'react';
import type { Game } from '../game/Game.ts';
import { InfoIcon } from '../ui/icons.tsx';

type Tab = 'start' | 'controls' | 'rules' | 'help';

const START: [string, string][] = [
  [
    'Earn',
    'Jobs: courier at the Courier Depot on the plaza, mining at the quarry, taxi at the Taxi Office (level 2). Pay goes to your bank (phone, P).',
  ],
  [
    'Your car',
    `A free rental from the Car Dealership for your first ${RENTAL.days} days: fetch it at any car park's blue P. Buy your own on Sol Boulevard before it's due back.`,
  ],
  ['Fuel', 'Cars burn fuel. Top up at any car park: step into the blue P beside your car.'],
  ['Trade', "Sell your cars to other players, or buy theirs, in the phone's Market."],
  [
    'Weapons',
    `The Gun Store in Mid City sells a pistol licence from level ${ARMORY.licence.minLevel}, then the pistol and rounds. Q takes it out, R reloads. Never in safe zones.`,
  ],
  [
    'Factions',
    'Join the police, EMS or a gang from the phone: apply, pass the training, then an interview with a member.',
  ],
  [
    'Trouble',
    'Call 911 or EMS from the phone. Downed? Call EMS and wait for a medic, or faint and wake in a Hospital bed, for a fee.',
  ],
];

const KEYS: [string, string][] = [
  ['WASD', 'Move (Shift to walk)'],
  ['Space', 'Jump; handbrake in a car'],
  ['H', 'Horn, in a car'],
  ['E', 'Use what the prompt shows: cars, the kiosk'],
  ['Click', 'Punch'],
  ['V (hold)', 'Talk to players nearby'],
  ['T or Enter', 'Chat'],
  ['G', 'Emotes'],
  ['P', 'Phone: bank, jobs, garage, market, factions, 911'],
  ['Q · R', 'Take out your weapon (next one, then none) · reload'],
];

const TOUCH: [string, string][] = [
  ['Left thumb', 'Move: the stick appears where you touch'],
  ['Right side', 'Drag to look around'],
  ['Prompt', 'Tap the round prompt to use a car or the kiosk'],
  ['Mic (hold)', 'Talk to players nearby'],
  ['In a car', 'Steer with the wheel; accelerator on the right, brake beside it'],
];

const RULES: [string, string][] = [
  ['Stay in character', 'Los Soles is a role-play city: play your character, not the game.'],
  ['No random violence', "Don't attack people without a story reason (no RDM)."],
  ['No car ramming', "Don't use cars as weapons (no VDM)."],
  ['Respect everyone', 'No hate, slurs or harassment, in chat or on the mic.'],
  ['No cheats or exploits', 'Bugs are for reporting, not using.'],
  ['Admins have the last word', 'Follow their calls in game; appeal afterwards.'],
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const rows =
    tab === 'start'
      ? START
      : tab === 'controls'
        ? touch
          ? TOUCH
          : KEYS
        : tab === 'rules'
          ? RULES
          : null;
  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet glass guide" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className="guide-i">
            <InfoIcon />
          </span>
          <div>
            <div className="sheet-title">Los Soles city guide</div>
            <div className="sheet-note">Welcome to the city. Here's how it works.</div>
          </div>
        </div>
        <div className="chips">
          {(
            [
              ['start', 'Getting started'],
              ['controls', 'Controls'],
              ['rules', 'House rules'],
              ['help', 'Getting help'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? 'on' : ''}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {rows ? (
          <dl className="guide-rows">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl className="guide-rows">
            <div>
              <dt>/help</dt>
              <dd>
                Type it in chat (add what happened) and the admins online are told where you are.
                Stuck in a wall or a car stuck somewhere? This is the way.
              </dd>
            </div>
            <div>
              <dt>Report</dt>
              <dd>Tap a player's name tag, then Report. Block hides their chat and voice.</dd>
            </div>
            <div>
              <dt>/commands</dt>
              <dd>Lists every chat command you can use.</dd>
            </div>
          </dl>
        )}
        <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
          Got it
        </button>
      </div>
    </div>
  );
}
