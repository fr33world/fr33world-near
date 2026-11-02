/**
 * A player's character (Phase 3): the name everyone sees, an age, and an appearance: a body, a
 * face and an outfit (Rocketbox), a skin tone, facial hair and clothes colours.
 * The appearance travels as one 32-bit number (in the world ticket and the `enter` message),
 * so every client draws everyone the same.
 */

export type Body = 'male' | 'female';

/**
 * Rocketbox characters (Microsoft, MIT) the game is built from (scripts/assets/rocketbox.mjs):
 * each gives a face (head and hair) and an outfit (body and clothes), and any face goes on any
 * outfit of the same body. Ids are the avatars' (m04 = Male_Adult_04). Append only: a player's
 * appearance stores indices into these lists.
 */
export const ROCKETBOX_FACES: Record<Body, readonly string[]> = {
  male: [
    'm01',
    'm02',
    'm03',
    'm04',
    'm05',
    'm06',
    'm07',
    'm08',
    'm09',
    'm10',
    'm11',
    'm12',
    'm13',
    'm14',
    'm16',
    'm17',
    'm18',
    'm20',
  ],
  female: [
    'f01',
    'f02',
    'f03',
    'f04',
    'f05',
    'f07',
    'f08',
    'f09',
    'f11',
    'f12',
    'f13',
    'f14',
    'f15',
    'f17',
  ],
};
export const ROCKETBOX_OUTFITS: Record<Body, readonly string[]> = {
  male: ['m01', 'm02', 'm04', 'm06', 'm08', 'm09', 'm10', 'm12', 'm16', 'm17', 'm18', 'm20'],
  female: [
    'f01',
    'f02',
    'f03',
    'f04',
    'f05',
    'f07',
    'f08',
    'f09',
    'f11',
    'f12',
    'f13',
    'f14',
    'f15',
    'f17',
  ],
};

/**
 * Skin tones besides each face's own (index 0): light to deep (sRGB). Albedo in the range the
 * Rocketbox textures use (their lightest faces are about the first), not display colours.
 */
export const SKIN_TONES = ['#dba385', '#cc8f6b', '#ab7352', '#87573b', '#663d29', '#45291c'];
/** Facial hair (men): none, stubble, goatee, moustache, full beard. */
export const FACIAL_HAIR = ['none', 'stubble', 'goatee', 'moustache', 'beard'] as const;
/** Clothes colours besides an item's own (index 0): black, white, red, navy, olive, grey, sand. */
export const CLOTHES_COLOURS = [
  '#1d1d1f',
  '#e6e6e3',
  '#a8242c',
  '#1f3a68',
  '#56633a',
  '#7d7f84',
  '#c4ae86',
];
/** Height steps (-4 % … +4 %) and builds (slim, regular, broad). */
export const HEIGHTS = [0.96, 0.98, 1, 1.02, 1.04];
export const BUILDS = [0.93, 1, 1.08];

export interface Appearance {
  body: Body;
  /** Index into ROCKETBOX_FACES[body]. */
  face: number;
  /** Index into ROCKETBOX_OUTFITS[body]. */
  outfit: number;
  /** 0: the face's own; else SKIN_TONES[skin - 1]. */
  skin: number;
  /** Index into FACIAL_HAIR (men only; 0 for women). */
  facialHair: number;
  /** 0: the outfit's own; else CLOTHES_COLOURS[n - 1]. */
  top: number;
  bottom: number;
  shoes: number;
  /**
   * Indices into HEIGHTS and BUILDS. Everyone is drawn one size now (owner, 2026-11-02): kept so
   * looks already saved stay valid, and nothing reads them.
   */
  height: number;
  build: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  body: 'male',
  face: 0,
  outfit: 0,
  skin: 0,
  facialHair: 0,
  top: 0,
  bottom: 0,
  shoes: 0,
  height: 2,
  build: 1,
};

const int = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;

/** A well-formed appearance (from a client: every field checked). */
export function isAppearance(v: unknown): v is Appearance {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (a.body !== 'male' && a.body !== 'female') return false;
  const colours = CLOTHES_COLOURS.length + 1;
  return (
    int(a.face, ROCKETBOX_FACES[a.body].length) &&
    int(a.outfit, ROCKETBOX_OUTFITS[a.body].length) &&
    int(a.skin, SKIN_TONES.length + 1) &&
    int(a.facialHair, a.body === 'male' ? FACIAL_HAIR.length : 1) &&
    int(a.top, colours) &&
    int(a.bottom, colours) &&
    int(a.shoes, colours) &&
    int(a.height, HEIGHTS.length) &&
    int(a.build, BUILDS.length)
  );
}

/** Bit fields, low to high: [field, width]. 31 bits in all. */
const FIELDS: [Exclude<keyof Appearance, 'body'>, number][] = [
  ['face', 5],
  ['outfit', 5],
  ['skin', 3],
  ['facialHair', 3],
  ['top', 3],
  ['bottom', 3],
  ['shoes', 3],
  ['height', 3],
  ['build', 2],
];

export function encodeAppearance(a: Appearance): number {
  let code = a.body === 'female' ? 1 : 0;
  let shift = 1;
  for (const [key, bits] of FIELDS) {
    code |= (a[key] & ((1 << bits) - 1)) << shift;
    shift += bits;
  }
  return code >>> 0;
}

/** The appearance in `code`; anything out of range falls back to the defaults. */
export function decodeAppearance(code: number): Appearance {
  const body: Body = code & 1 ? 'female' : 'male';
  const a = { ...DEFAULT_APPEARANCE, body };
  let shift = 1;
  for (const [key, bits] of FIELDS) {
    a[key] = (code >>> shift) & ((1 << bits) - 1);
    shift += bits;
  }
  return isAppearance(a) ? a : { ...DEFAULT_APPEARANCE, body };
}

export const CHARACTER_AGE = { min: 18, max: 80 };

/**
 * A role-play name: a first and a last name, each 2–14 letters (a hyphen or apostrophe
 * inside is fine), capitalised. Returns the tidied name, or an error to show.
 */
export function checkCharacterName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Enter a first and a last name.' };
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return { error: 'Enter a first and a last name.' };
  const word = /^[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?$/;
  for (const p of parts) {
    if (!word.test(p))
      return { error: 'Names use letters only (a hyphen or apostrophe inside is fine).' };
    if (p.length < 2 || p.length > 14) return { error: 'Each name is 2 to 14 letters.' };
  }
  // Capitalised; the rest as typed (McDonald, O'Neil), unless it was all capitals.
  const name = parts
    .map((p) => {
      const rest = p === p.toUpperCase() ? p.slice(1).toLowerCase() : p.slice(1);
      return (p[0] as string).toUpperCase() + rest;
    })
    .join(' ');
  return { name };
}
