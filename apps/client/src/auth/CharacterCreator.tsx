/**
 * Character creation (Phase 3), the last step before the city: a role-play name (checked as
 * it's typed: free, and how it will be written), an age, and an appearance shown on a live 3D
 * preview that can be turned. The appearance, in tabs: a face (and skin tone, and facial hair
 * for men), an outfit with its top, bottom and shoes recoloured, and
 * extras (a hat, eyewear, a chain, a watch, a bag). The server checks it all again.
 */
import {
  type Appearance,
  type Body,
  CHARACTER_AGE,
  checkCharacterName,
  CLOTHES_COLOURS,
  DEFAULT_APPEARANCE,
  FACIAL_HAIR,
  type Gear,
  NO_GEAR,
  randomCharacterName,
  ROCKETBOX_FACES,
  ROCKETBOX_OUTFITS,
  SKIN_TONES,
} from '@fr33world/shared';
import { DiceIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useRef, useState } from 'react';
import { checkCharacterNameFree } from '../game/api.ts';
import type { CharacterPreview } from '../game/character/preview.ts';

const FACIAL_NAMES: Record<(typeof FACIAL_HAIR)[number], string> = {
  none: 'Clean',
  stubble: 'Stubble',
  goatee: 'Goatee',
  moustache: 'Moustache',
  beard: 'Beard',
};
type Tab = 'you' | 'face' | 'style' | 'extras';
const TABS: [Tab, string][] = [
  ['you', 'You'],
  ['face', 'Face'],
  ['style', 'Style'],
  ['extras', 'Extras'],
];
/** The extras' names on screen (the lists are named for the code). */
const EXTRAS: {
  key: 'head' | 'eyes' | 'neck' | 'wrist' | 'bag';
  label: string;
  names: string[];
}[] = [
  { key: 'head', label: 'Hat', names: ['None', 'Cap', 'Cap back', 'Beanie', 'Bucket'] },
  { key: 'eyes', label: 'Eyewear', names: ['None', 'Shades', 'Glasses', 'Aviators'] },
  { key: 'neck', label: 'Chain', names: ['None', 'Gold', 'Silver', 'Cuban'] },
  { key: 'wrist', label: 'Watch', names: ['None', 'Gold', 'Silver', 'Black'] },
  { key: 'bag', label: 'Bag', names: ['None', 'Backpack', 'Sling'] },
];

export interface NewCharacter {
  name: string;
  age: number;
  appearance: Appearance;
  gear: Gear;
}

type NameState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; name: string }
  | { kind: 'bad'; message: string };

export function CharacterCreator({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onCreate: (c: NewCharacter) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const [look, setLook] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [gear, setGear] = useState<Gear>(NO_GEAR);
  const [name, setName] = useState('');
  const [age, setAge] = useState(24);
  const [nameState, setNameState] = useState<NameState>({ kind: 'idle' });
  const [previewReady, setPreviewReady] = useState(false);
  const [tab, setTab] = useState<Tab>('you');

  // The 3D preview: its own download, started when the screen opens.
  useEffect(() => {
    let alive = true;
    void import('../game/character/preview.ts').then(({ CharacterPreview }) => {
      const canvas = canvasRef.current;
      if (!alive || !canvas) return;
      previewRef.current = new CharacterPreview(canvas);
      void previewRef.current.show(look, gear).then(() => alive && setPreviewReady(true));
    });
    return () => {
      alive = false;
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, []);
  useEffect(() => {
    void previewRef.current?.show(look, gear);
  }, [look, gear]);

  // The name: checked here as it's typed, then with the server (free?) after a pause.
  useEffect(() => {
    if (!name.trim()) return setNameState({ kind: 'idle' });
    const local = checkCharacterName(name);
    if ('error' in local) return setNameState({ kind: 'bad', message: local.error });
    setNameState({ kind: 'checking' });
    const id = setTimeout(() => {
      checkCharacterNameFree(name).then(
        (r) =>
          setNameState(
            'error' in r
              ? { kind: 'bad', message: r.error }
              : r.available
                ? { kind: 'ok', name: r.name }
                : { kind: 'bad', message: `${r.name} is taken.` },
          ),
        // Can't reach the server to check: let the create step decide.
        () => setNameState({ kind: 'ok', name: local.name }),
      );
    }, 450);
    return () => clearTimeout(id);
  }, [name]);

  const set = (change: Partial<Appearance>) => setLook((l) => ({ ...l, ...change }));
  // A new body starts from its first face and outfit (each body has its own).
  const setBody = (body: Body) => set({ body, face: 0, outfit: 0, facialHair: 0 });
  const ready = nameState.kind === 'ok' && !busy;

  return (
    <div className="creator">
      <div className="creator-stage">
        <canvas ref={canvasRef} className="creator-canvas" />
        {!previewReady && <div className="creator-loading">Loading your character…</div>}
        <div className="creator-hint">Drag to turn</div>
      </div>
      <form
        className="creator-panel glass"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameState.kind === 'ok')
            onCreate({ name: nameState.name, age, appearance: look, gear });
        }}
      >
        <div className="login-heading">Create your character</div>
        <div className="creator-tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'on' : ''}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="creator-tab">
          {tab === 'you' && (
            <>
              <label className="field">
                <span>Name</span>
                <div className="name-row">
                  <input
                    value={name}
                    maxLength={30}
                    autoComplete="off"
                    placeholder="First and last name"
                    onChange={(e) => setName(e.target.value)}
                  />
                  {/* No name in mind: one that sounds real, as games offer. */}
                  <button
                    type="button"
                    className="name-dice"
                    aria-label="Random name"
                    title="Random name"
                    onClick={() => setName(randomCharacterName(look.body))}
                  >
                    <HugeiconsIcon icon={DiceIcon} size={22} strokeWidth={1.8} />
                  </button>
                </div>
              </label>
              <div className={`creator-name ${nameState.kind}`}>
                {nameState.kind === 'checking'
                  ? 'Checking…'
                  : nameState.kind === 'ok'
                    ? `${nameState.name} is free`
                    : nameState.kind === 'bad'
                      ? nameState.message
                      : 'Everyone in Los Soles will know you by this name.'}
              </div>
              <label className="field">
                <span>Age · {age}</span>
                <input
                  type="range"
                  min={CHARACTER_AGE.min}
                  max={CHARACTER_AGE.max}
                  value={age}
                  onChange={(e) => setAge(Number(e.target.value))}
                />
              </label>
              <Row label="Body">
                <Segmented
                  names={['Masculine', 'Feminine']}
                  value={look.body === 'male' ? 0 : 1}
                  onChange={(i) => setBody(i === 0 ? 'male' : 'female')}
                />
              </Row>
            </>
          )}
          {tab === 'face' && (
            <>
              <Row label="Face">
                <Stepper
                  value={look.face}
                  count={ROCKETBOX_FACES[look.body].length}
                  onChange={(face) => set({ face })}
                />
              </Row>
              <Row label="Skin">
                <Swatches
                  colours={SKIN_TONES}
                  naturalLabel="The face's own skin"
                  value={look.skin}
                  onChange={(skin) => set({ skin })}
                />
              </Row>
              {look.body === 'male' && (
                <Row label="Facial hair">
                  <div className="chips">
                    {FACIAL_HAIR.map((f, i) => (
                      <button
                        key={f}
                        type="button"
                        className={look.facialHair === i ? 'on' : ''}
                        onClick={() => set({ facialHair: i })}
                      >
                        {FACIAL_NAMES[f]}
                      </button>
                    ))}
                  </div>
                </Row>
              )}
            </>
          )}
          {tab === 'style' && (
            <>
              <Row label="Outfit">
                <Stepper
                  value={look.outfit}
                  count={ROCKETBOX_OUTFITS[look.body].length}
                  onChange={(outfit) => set({ outfit })}
                />
              </Row>
              {(['top', 'bottom', 'shoes'] as const).map((part) => (
                <Row
                  key={part}
                  label={part === 'top' ? 'Top' : part === 'bottom' ? 'Bottom' : 'Shoes'}
                >
                  <Swatches
                    colours={CLOTHES_COLOURS}
                    naturalLabel="As it comes"
                    value={look[part]}
                    onChange={(c) => set({ [part]: c })}
                  />
                </Row>
              ))}
            </>
          )}
          {tab === 'extras' && (
            <>
              {EXTRAS.map(({ key, label, names }) => (
                <Row key={key} label={label}>
                  <div className="chips">
                    {names.map((n, i) => (
                      <button
                        key={n}
                        type="button"
                        className={gear[key] === i ? 'on' : ''}
                        onClick={() => setGear((g) => ({ ...g, [key]: i }))}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  {(key === 'head' || key === 'bag') && gear[key] !== 0 && (
                    <div className="swatches">
                      {CLOTHES_COLOURS.map((c, i) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={`Colour ${i + 1}`}
                          className={
                            gear[key === 'head' ? 'headColour' : 'bagColour'] === i ? 'on' : ''
                          }
                          style={{ background: c }}
                          onClick={() =>
                            setGear((g) => ({
                              ...g,
                              [key === 'head' ? 'headColour' : 'bagColour']: i,
                            }))
                          }
                        />
                      ))}
                    </div>
                  )}
                </Row>
              ))}
            </>
          )}
        </div>
        <button className="btn btn-primary" type="submit" disabled={!ready}>
          {busy ? 'Creating…' : 'Create and enter Los Soles'}
        </button>
        <div className="login-fine">
          {nameState.kind === 'ok'
            ? "Your name and age can't be changed later."
            : 'Choose a name to continue.'}
        </div>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="creator-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

function Segmented({
  names,
  value,
  onChange,
}: {
  names: string[];
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <div className="segmented">
      {names.map((n, i) => (
        <button
          key={n}
          type="button"
          className={value === i ? 'on' : ''}
          onClick={() => onChange(i)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** Previous and next through `count` choices, wrapping around. */
function Stepper({
  value,
  count,
  onChange,
}: {
  value: number;
  count: number;
  onChange: (i: number) => void;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        aria-label="Previous"
        onClick={() => onChange((value + count - 1) % count)}
      >
        ‹
      </button>
      <span>
        {value + 1} <small>of {count}</small>
      </span>
      <button type="button" aria-label="Next" onClick={() => onChange((value + 1) % count)}>
        ›
      </button>
    </div>
  );
}

/** Colour choices after a first "natural" one (0: the face's or the item's own colour). */
function Swatches({
  colours,
  naturalLabel,
  value,
  onChange,
}: {
  colours: readonly string[];
  naturalLabel: string;
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <div className="swatches">
      <button
        type="button"
        aria-label={naturalLabel}
        title={naturalLabel}
        className={`natural ${value === 0 ? 'on' : ''}`}
        onClick={() => onChange(0)}
      />
      {colours.map((c, i) => (
        <button
          key={c}
          type="button"
          aria-label={`Colour ${i + 1}`}
          className={value === i + 1 ? 'on' : ''}
          style={{ background: c }}
          onClick={() => onChange(i + 1)}
        />
      ))}
    </div>
  );
}
