/**
 * Factions (Phase 9, decision D-26): the police, the medics and two gangs. Players join through
 * an application, training (a short graded quiz on the faction's rules), an interview with a
 * member who can recruit, and acceptance by them. Ranks carry titles, powers and, for the
 * police and medics, a salary for every SALARY.everyMs of active time on duty (from the salary
 * faucet). Gangs earn no salary; their rank opens the black market (shared ARMORY).
 */

export type FactionId = 'police' | 'medical' | 'vipers' | 'kings';
export type FactionKind = 'police' | 'medical' | 'gang';
/** What a rank may do: take recruits on, promote and demote, dismiss, fine (police). */
export type FactionPower = 'recruit' | 'promote' | 'dismiss' | 'fine';

export interface Rank {
  title: string;
  /** Cents for each SALARY.everyMs on duty (0 for gangs). */
  salary: number;
  powers: FactionPower[];
}

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Index of the right option. */
  answer: number;
}

export interface Faction {
  id: FactionId;
  name: string;
  short: string;
  kind: FactionKind;
  /** Name-tag and badge colour. */
  colour: string;
  ranks: Rank[];
  quiz: QuizQuestion[];
}

export const SALARY = {
  /** Pay for every this much active time on duty (config; the owner plans 30 min later). */
  everyMs: 10 * 60_000,
  /** Not moved for this long: on duty but away, and the time doesn't count. */
  idleMs: 3 * 60_000,
  /** XP with each pay. */
  xp: 25,
} as const;

/** A police fine's bounds (cents). */
export const FINE = { min: 5_000, max: 500_000 } as const;

/** Quiz: questions right out of five to pass, and the wait before another try (ms). */
export const QUIZ = { size: 5, pass: 4, retryMs: 10 * 60_000 } as const;

const RULES: QuizQuestion[] = [
  {
    q: 'Someone runs you over on purpose for no reason. What do you do?',
    options: ['Shoot them', 'Report it from their player card', 'Ram them back'],
    answer: 1,
  },
  {
    q: 'Where are guns never allowed?',
    options: ['The plaza and other safe zones', 'Downtown', 'Nowhere'],
    answer: 0,
  },
];

/** More of the city's rules, drawn from at random so a set of answers can't be passed round. */
const MORE_RULES: QuizQuestion[] = [
  {
    q: 'Your voice chat should be…',
    options: ['In character, near others', 'Shouting over everyone', 'Advertising'],
    answer: 0,
  },
  {
    q: 'You see someone exploiting a bug for money. You…',
    options: ['Do it too', 'Tell nobody', 'Report it'],
    answer: 2,
  },
  {
    q: 'Before you shoot someone, there should be…',
    options: ['Nothing', 'A reason in the story', 'A bet'],
    answer: 1,
  },
  {
    q: 'Someone is on a hospital bed. You may…',
    options: ['Leave them to heal', 'Wait outside and shoot them', 'Take their things'],
    answer: 0,
  },
  {
    q: 'A player is rude to you in chat. You…',
    options: ['Block or report them', 'Threaten them in real life', 'Post their details'],
    answer: 0,
  },
  {
    q: 'Who decides whether a shot hit?',
    options: ['You', 'The server', 'Whoever shouts'],
    answer: 1,
  },
  {
    q: 'You need money fast. The right way is…',
    options: ['A job or a shift', 'Asking staff for free cash', 'A duplicate glitch'],
    answer: 0,
  },
];

const ranks = (titles: string[], salaries: number[]): Rank[] =>
  titles.map((title, i) => ({
    title,
    salary: salaries[i] ?? 0,
    powers:
      i >= 4
        ? ['recruit', 'promote', 'dismiss', 'fine']
        : i === 3
          ? ['recruit', 'promote', 'fine']
          : i === 2
            ? ['recruit', 'fine']
            : i === 1
              ? ['fine']
              : [],
  }));

export const FACTIONS: Record<FactionId, Faction> = {
  police: {
    id: 'police',
    name: 'Los Soles Police',
    short: 'LSP',
    kind: 'police',
    colour: '#3d8bff',
    ranks: ranks(
      ['Cadet', 'Officer', 'Sergeant', 'Lieutenant', 'Chief'],
      [15_000, 20_000, 24_000, 27_000, 30_000],
    ),
    quiz: [
      ...RULES,
      {
        q: 'A driver is speeding through the plaza. You…',
        options: ['Shoot their tyres', 'Pull them over and fine them', 'Ignore it'],
        answer: 1,
      },
      {
        q: 'Before fining someone you should…',
        options: ['Check their ID and explain why', 'Take their car', 'Arrest them'],
        answer: 0,
      },
      {
        q: 'Your duty pistol is for…',
        options: ['Any argument', 'Protecting life when there is no other way', 'Fun'],
        answer: 1,
      },
    ],
  },
  medical: {
    id: 'medical',
    name: 'EMS',
    short: 'EMS',
    kind: 'medical',
    colour: '#ff5a52',
    ranks: ranks(
      ['Trainee', 'Paramedic', 'Senior Paramedic', 'Doctor', 'Chief of Medicine'],
      [15_000, 20_000, 24_000, 27_000, 30_000],
    ),
    quiz: [
      ...RULES,
      {
        q: 'Someone is down in the street. First you…',
        options: ['Check the scene is safe, then go to them', 'Wait for police', 'Leave'],
        answer: 0,
      },
      {
        q: 'Who do you treat?',
        options: ['Only friends', 'Anyone who needs it', 'Only those who pay'],
        answer: 1,
      },
      {
        q: 'A call comes in on the dispatch. You…',
        options: ['Respond and head there', 'Ignore it', 'Call someone else'],
        answer: 0,
      },
    ],
  },
  vipers: {
    id: 'vipers',
    name: 'Eastside Vipers',
    short: 'Vipers',
    kind: 'gang',
    colour: '#7def06',
    ranks: ranks(['Prospect', 'Member', 'Enforcer', 'Lieutenant', 'Boss'], []),
    quiz: [
      ...RULES,
      {
        q: 'The crew has a beef with someone. You…',
        options: ['Roleplay it out first', 'Shoot on sight', 'Spam them in chat'],
        answer: 0,
      },
      {
        q: 'Who leads the Vipers?',
        options: ['Whoever is loudest', 'The Boss', 'Nobody'],
        answer: 1,
      },
      {
        q: 'Our turf is…',
        options: ['Eastside', 'The plaza', 'The beach'],
        answer: 0,
      },
    ],
  },
  kings: {
    id: 'kings',
    name: 'South Grid Kings',
    short: 'Kings',
    kind: 'gang',
    colour: '#b36bff',
    ranks: ranks(['Prospect', 'Member', 'Enforcer', 'Lieutenant', 'Boss'], []),
    quiz: [
      ...RULES,
      {
        q: 'The crew has a beef with someone. You…',
        options: ['Roleplay it out first', 'Shoot on sight', 'Spam them in chat'],
        answer: 0,
      },
      {
        q: 'Who leads the Kings?',
        options: ['Whoever is loudest', 'The Boss', 'Nobody'],
        answer: 1,
      },
      {
        q: 'Our turf is…',
        options: ['The South Grid', 'Downtown', 'The hills'],
        answer: 0,
      },
    ],
  },
};

/** What a newcomer reads at the join point: who they are, what they get, and how to get in. */
export interface FactionGuide {
  tagline: string;
  perks: string[];
  /** A gang's door: why it's shut to you. */
  door?: string;
}

export const FACTION_GUIDE: Record<FactionId, FactionGuide> = {
  police: {
    tagline: 'Paid on duty',
    perks: ['$150–$300 per 10 min', 'Uniform, pistol, cruiser', 'Issue fines'],
  },
  medical: {
    tagline: 'Paid on duty',
    perks: ['$150–$300 per 10 min', 'Uniform, ambulance', 'Paid per revive'],
  },
  vipers: {
    tagline: 'No salary',
    door: 'Members only.',
    perks: ['Paid collections', 'Black market rifles', 'House key, crew radio'],
  },
  kings: {
    tagline: 'No salary',
    door: 'Members only.',
    perks: ['Paid collections', 'Black market rifles', 'House key, crew radio'],
  },
};

/** The way in, the same for every faction: where an application is, in order. */
export const JOIN_STEPS = [
  { title: 'Apply', text: 'Say why' },
  { title: 'Training', text: `${QUIZ.pass} of ${QUIZ.size} on your phone` },
  { title: 'Interview', text: 'Meet a boss here' },
  { title: 'You’re in', text: 'Start at the bottom' },
] as const;

export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

export const isFactionId = (v: unknown): v is FactionId =>
  typeof v === 'string' && (FACTION_IDS as string[]).includes(v);

/** A membership: which faction, and the rank (1 = newest). */
export interface Membership {
  faction: FactionId;
  rank: number;
}

/** A rank's details, or null. */
export function rankOf(m: Membership | null): Rank | null {
  if (!m) return null;
  return FACTIONS[m.faction]?.ranks[m.rank - 1] ?? null;
}

/** Whether a member's rank has a power. */
export function hasPower(m: Membership | null, power: FactionPower): boolean {
  return rankOf(m)?.powers.includes(power) ?? false;
}

/** Faction numbers on the wire (name tags): 0 none, then FACTION_IDS order. */
/** A short list from the rules and this faction's own, the same for the same `seed`. */
export function quizFor(faction: FactionId, seed: number): QuizQuestion[] {
  const pool = [...FACTIONS[faction].quiz, ...MORE_RULES];
  let s = (seed * 2_654_435_761 + 97) >>> 0;
  for (let i = pool.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    const j = s % (i + 1);
    [pool[i], pool[j]] = [pool[j] as QuizQuestion, pool[i] as QuizQuestion];
  }
  return pool.slice(0, QUIZ.size);
}

/** Starting a gang of your own (owner, 2026-10-31), and how the board counts. */
export const GANG = {
  price: 5_000_000,
  minLevel: 10,
  /** Members a gang needs to show on the board. */
  minMembers: 3,
} as const;

const BANNED = /(nigg|fag|nazi|rape|hitler|kkk|retard)/i;

/** Why a gang can't have this name and tag; null if it can. */
export function gangNameProblem(name: string, tag: string): string | null {
  if (!/^[\p{L}0-9 '-]{3,24}$/u.test(name)) return 'Names are 3 to 24 letters or numbers.';
  if (!/^[\p{L}0-9]{2,5}$/u.test(tag)) return 'Tags are 2 to 5 letters or numbers.';
  if (BANNED.test(name) || BANNED.test(tag)) return 'Not that name.';
  return null;
}

/** The faction's building, for a pin on the map. */
export const FACTION_BUILDING: Record<FactionId, 'police' | 'hospital' | 'vipers' | 'kings'> = {
  police: 'police',
  medical: 'hospital',
  vipers: 'vipers',
  kings: 'kings',
};

/** The faction a building belongs to, if any. */
export function factionOfBuilding(building: string | undefined): FactionId | null {
  return FACTION_IDS.find((f) => FACTION_BUILDING[f] === building) ?? null;
}

/** In `enter`, the faction code's top bit: on duty (the uniform shows). */
export const ON_DUTY_BIT = 128;

/** What a faction wears: top, bottom and shoes (sRGB). Police and EMS on duty; gangs always. */
export const UNIFORMS: Record<FactionId, readonly [string, string, string]> = {
  police: ['#1f3a68', '#16233f', '#141416'],
  medical: ['#e8f2f2', '#1f8a8c', '#e6e6e3'],
  vipers: ['#2fbf6a', '#1d1d1f', '#1d1d1f'],
  kings: ['#e0b73c', '#1d1d1f', '#1d1d1f'],
};

/**
 * The real uniforms at the lockers: Rocketbox's own Police and Medical avatars, one per rank.
 * Each id is the outfit's file (`rb_<id>_outfit`), and its avatar in the library.
 */
export const UNIFORM_AVATARS: Record<string, string> = {
  pm1: 'Police_Male_01',
  pm3: 'Police_Male_03',
  pm5: 'Police_Male_05',
  pm6: 'Police_Male_06',
  pm7: 'Police_Male_07',
  pf1: 'Police_Female_01',
  sf1: 'Security_Female_01',
  lf1: 'Pilot_Female_01',
  em1: 'Medical_Male_01',
  em2: 'Medical_Male_02',
  em3: 'Medical_Male_03',
  em4: 'Medical_Male_04',
  ef1: 'Medical_Female_01',
  ef2: 'Medical_Female_02',
  ef3: 'Medical_Female_03',
};

/** Which uniform each rank wears, lowest rank first. */
export const RANK_UNIFORMS: Partial<
  Record<FactionId, Record<'male' | 'female', readonly string[]>>
> = {
  police: {
    male: ['pm1', 'pm3', 'pm6', 'pm7', 'pm5'],
    female: ['sf1', 'sf1', 'pf1', 'pf1', 'lf1'],
  },
  medical: {
    male: ['em4', 'em2', 'em2', 'em1', 'em3'],
    female: ['ef1', 'ef3', 'ef3', 'ef2', 'ef2'],
  },
};

/** The uniform this member changes into at the lockers, if their faction has real ones. */
export function uniformOutfit(
  faction: FactionId | null | undefined,
  rank: number,
  onDuty: boolean,
  body: 'male' | 'female',
): string | null {
  if (!faction || !onDuty) return null;
  const list = RANK_UNIFORMS[faction]?.[body];
  return list ? (list[Math.min(Math.max(rank, 1), list.length) - 1] ?? null) : null;
}

/** The clothes this faction member wears now, if the faction dresses them. */
export function uniformOf(
  faction: FactionId | null | undefined,
  onDuty: boolean,
): readonly [string, string, string] | null {
  if (!faction) return null;
  return FACTIONS[faction].kind === 'gang' || onDuty ? UNIFORMS[faction] : null;
}

export const factionCode = (f: FactionId | null | undefined): number =>
  f ? FACTION_IDS.indexOf(f) + 1 : 0;
export const factionOfCode = (n: number): FactionId | null => FACTION_IDS[n - 1] ?? null;

/** `enter`'s faction byte: the faction in the low 3 bits, the rank above, on duty on top. */
export function factionTag(m: Membership | null | undefined, onDuty: boolean): number {
  return factionCode(m?.faction) | ((m?.rank ?? 0) << 3) | (onDuty ? ON_DUTY_BIT : 0);
}
export function readFactionTag(tag: number): {
  faction: FactionId | null;
  rank: number;
  onDuty: boolean;
} {
  return {
    faction: factionOfCode(tag & 7),
    rank: (tag >> 3) & 15,
    onDuty: (tag & ON_DUTY_BIT) !== 0,
  };
}
