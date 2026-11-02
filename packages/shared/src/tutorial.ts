/**
 * The tutorial (PRD §5): Luz, the city's guide, teaches the game through play, step by step.
 * Progress is saved with the character (apps/api), so an interrupted tutorial resumes where it
 * was; it can be skipped at any time. Finishing it pays once (the tutorial faucet).
 */
export const TUTORIAL_STEPS = [
  'welcome',
  'move',
  'look',
  'map',
  'kiosk',
  'job',
  'phone',
  'car',
  'social',
  'done',
] as const;
export type TutorialStep = (typeof TUTORIAL_STEPS)[number] | 'skipped';

export const TUTORIAL_REWARD = { cents: 50_000, xp: 300 } as const;

export const isTutorialStep = (s: unknown): s is TutorialStep =>
  s === 'skipped' || (TUTORIAL_STEPS as readonly unknown[]).includes(s);
