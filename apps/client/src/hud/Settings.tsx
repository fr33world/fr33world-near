/**
 * Settings: the gear at the top right opens them, in tabs. Graphics (Auto, Low, Medium, High,
 * Ultra; applied by reloading, since budgets like shadow maps and draw distance are fixed when
 * the city is built), Sound (master, music, effects, voices), Controls (look speed, up and
 * down the other way, and the controls themselves), and Account (a guest links an account
 * here to keep their character). Everything is saved on this device.
 */
import { usePrivy } from '@privy-io/react-auth';
import { type ReactNode, useEffect, useState } from 'react';
import { LinkButtons } from '../auth/LoginScreen.tsx';
import {
  type GraphicsSetting,
  GRAPHICS_SETTINGS,
  graphicsSetting,
  isTouchDevice,
  saveGraphicsSetting,
} from '../game/quality.ts';
import { onSettings, type PlayerSettings, updateSettings } from '../game/settings.ts';
import {
  Award01Icon,
  ComputerIcon,
  GameController01Icon,
  UserIcon,
  VolumeHighIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { GearIcon } from '../ui/icons.tsx';
import { Ico, Modal } from '../ui/Modal.tsx';

const LABELS: Record<GraphicsSetting, { name: string; about: string }> = {
  auto: { name: 'Auto', about: 'Picks for your device and keeps the game smooth' },
  low: { name: 'Low', about: 'Older phones: no shadows, shorter view' },
  medium: { name: 'Medium', about: 'Most phones: shadows, sharper textures' },
  high: { name: 'High', about: 'Laptops: full detail, long view' },
  ultra: { name: 'Ultra', about: 'Strong computers: the sharpest shadows and textures' },
};

const KEYS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Mouse', 'Look around (click the game first)'],
  ['Shift', 'Walk'],
  ['Space', 'Jump; handbrake in a car'],
  ['H', 'Horn, in a car'],
  ['E', 'Get in or out of a car'],
  ['Left mouse', 'Punch'],
  ['V (hold)', 'Talk to players nearby'],
  ['T or Enter', 'Chat to players nearby'],
  ['G', 'Emotes (then 1–9)'],
];
const TOUCH: [string, string][] = [
  ['Left thumb', 'Move: put it down anywhere on the left'],
  ['Right side', 'Drag to look around'],
  ['Buttons', 'Jump, punch, get in a car, hold the microphone to talk, chat, emotes'],
];

type Tab = 'graphics' | 'sound' | 'controls' | 'account' | 'credits';

export function Settings({
  current,
  account,
}: {
  current: string;
  /** Logged in (Privy is there): whether as a guest. Null plays without an account. */
  account: { name: string; guest: boolean } | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('graphics');
  const [s, setS] = useState<PlayerSettings | null>(null);
  useEffect(() => onSettings(setS), []);
  const tabs: [Tab, string, IconSvgElement][] = [
    ['graphics', 'Graphics', ComputerIcon],
    ['sound', 'Sound', VolumeHighIcon],
    ['controls', 'Controls', GameController01Icon],
    ...(account ? ([['account', 'Account', UserIcon]] as [Tab, string, IconSvgElement][]) : []),
    ['credits', 'Credits', Award01Icon],
  ];
  return (
    <>
      <button
        className="tbtn glass"
        aria-label="Settings"
        style={{
          right: 'var(--safe-r)',
          top: 'var(--safe-t)',
          width: 38,
          height: 38,
          position: 'fixed',
        }}
        onClick={() => setOpen(true)}
      >
        <GearIcon />
      </button>
      {open && s && (
        <Modal
          title={tabs.find(([t]) => t === tab)?.[1] ?? 'Settings'}
          kicker="Settings"
          accent="#c9ced6"
          medal="settings"
          size="lg"
          className="m-settings"
          rail={
            <>
              <img className="m-brand" src="/brand/emblem.webp" alt="" draggable={false} />
              <nav className="m-nav" role="tablist" aria-orientation="vertical">
                {tabs.map(([t, label, icon]) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={tab === t ? 'on' : ''}
                    onClick={() => setTab(t)}
                  >
                    <Ico icon={icon} size={19} />
                    {label}
                  </button>
                ))}
              </nav>
            </>
          }
          onClose={() => setOpen(false)}
        >
          <div className="settings-body">
            {tab === 'graphics' && <Graphics current={current} />}
            {tab === 'sound' && (
              <>
                <Level
                  label="Master"
                  value={s.master}
                  set={(master) => updateSettings({ master })}
                />
                <Level label="Music" value={s.music} set={(music) => updateSettings({ music })} />
                <Level
                  label="Effects"
                  value={s.effects}
                  set={(effects) => updateSettings({ effects })}
                />
                <Level
                  label="Voices nearby"
                  value={s.voice}
                  set={(voice) => updateSettings({ voice })}
                />
              </>
            )}
            {tab === 'controls' && (
              <>
                <Row label={`Look speed · ${s.lookSpeed.toFixed(1)}×`}>
                  <input
                    type="range"
                    min={0.3}
                    max={3}
                    step={0.1}
                    value={s.lookSpeed}
                    onChange={(e) => updateSettings({ lookSpeed: Number(e.target.value) })}
                  />
                </Row>
                <Row label="Look up and down">
                  <div className="segmented">
                    {(['Normal', 'Inverted'] as const).map((n, i) => (
                      <button
                        key={n}
                        type="button"
                        className={s.invertY === (i === 1) ? 'on' : ''}
                        onClick={() => updateSettings({ invertY: i === 1 })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </Row>
                <dl className="keys">
                  {(isTouchDevice() ? TOUCH : KEYS).map(([k, what]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            {tab === 'account' && account && <Account account={account} />}
            {tab === 'credits' && <Credits />}
          </div>
        </Modal>
      )}
    </>
  );
}

function Graphics({ current }: { current: string }) {
  const chosen = graphicsSetting();
  const pick = (g: GraphicsSetting) => {
    if (g === chosen) return;
    saveGraphicsSetting(g);
    // Drop a ?q= test override so the saved choice takes effect.
    const url = new URL(location.href);
    url.searchParams.delete('q');
    location.replace(url.toString());
  };
  return (
    <>
      <div className="sheet-note">Now: {current}</div>
      {/* Each setting shown as the city looks at it (the same street, ui/graphics/). */}
      <div className="tiers">
        {GRAPHICS_SETTINGS.map((g) => (
          <button
            key={g}
            type="button"
            className={`tier${g === chosen ? ' chosen' : ''}`}
            style={{ backgroundImage: `url(/ui/graphics/${g}.webp)` }}
            onClick={() => pick(g)}
          >
            {g === chosen && <span className="tier-tag">In use</span>}
            <span className="tier-name">{LABELS[g].name}</span>
            <span className="tier-about">{LABELS[g].about}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="creator-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** A volume, 0–100%. */
function Level({ label, value, set }: { label: string; value: number; set: (v: number) => void }) {
  return (
    <Row label={`${label} · ${Math.round(value * 100)}%`}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </Row>
  );
}

/** Who's playing; a guest links an account here (Privy upgrades the same user). */
function Account({ account }: { account: { name: string; guest: boolean } }) {
  const { user, linkEmail, linkGoogle, linkDiscord, linkTwitter } = usePrivy();
  // Linking upgrades the user in place: it shows here at once.
  const guest = account.guest && (user?.isGuest ?? true);
  return (
    <>
      <div className="login-note">
        Playing as <b>{account.name}</b>
      </div>
      {guest ? (
        <>
          <div className="login-fine">
            A guest: on this device only, for 30 days. Link an account to keep your character, money
            and progress for good.
          </div>
          <LinkButtons
            links={{ email: linkEmail, google: linkGoogle, discord: linkDiscord, x: linkTwitter }}
          />
        </>
      ) : (
        <div className="login-fine">Your progress is saved to your account.</div>
      )}
    </>
  );
}

/**
 * Credits for the work fr33world uses under licences that ask for it (CC BY 4.0), as their
 * authors wish: title, author, source and licence, and what was changed. The full list of
 * every asset and its licence is in the project's assets/registry.yaml.
 */
const CREDITS: { title: string; author: string; url: string }[] = [
  {
    title: 'Generic passenger car pack',
    author: 'Comrade1280',
    url: 'https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5',
  },
  {
    title: "Canyon '75 Taxi",
    author: 'Daniel Zhabotinsky',
    url: 'https://sketchfab.com/3d-models/canyon-75-taxi-low-poly-model-9e8f92a215784f3d8aaaaeab1bef54c4',
  },
  {
    title: "Fairheaven LT '80 Cop Cruiser",
    author: 'Daniel Zhabotinsky',
    url: 'https://sketchfab.com/3d-models/fairheaven-lt-80-cop-cruiser-low-poly-model-61766c1e6e1e4b2b803c174f33433a74',
  },
  {
    title: "Shvan '92 Ambulance",
    author: 'Daniel Zhabotinsky',
    url: 'https://sketchfab.com/3d-models/shvan-92-ambulance-low-poly-model-2856dd3c61f940909dced9a5c0379484',
  },
];

function Credits() {
  return (
    <div className="credits">
      <div className="sheet-note">
        Cars: licensed CC BY 4.0. Re-oriented, resized and compressed for the game.
      </div>
      {CREDITS.map((c) => (
        <div key={c.title} className="credit">
          <b>{c.title}</b>
          <span>
            by {c.author} ·{' '}
            <a href={c.url} target="_blank" rel="noreferrer">
              Sketchfab
            </a>{' '}
            ·{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
          </span>
        </div>
      ))}
      <div className="sheet-note">
        Characters: Microsoft Rocketbox (MIT). Animations: Mixamo. Textures: Poly Haven and
        ambientCG (CC0). Fonts: Barlow and Bebas Neue (OFL).
      </div>
      <div className="sheet-note">
        Medallion shapes:{' '}
        <a href="https://game-icons.net" target="_blank" rel="noreferrer">
          game-icons.net
        </a>{' '}
        by Lorc, Delapouite and contributors (CC BY 3.0), modelled in 3D for the game. Interface
        icons: Hugeicons. The USDC mark belongs to Circle.
      </div>
    </div>
  );
}
