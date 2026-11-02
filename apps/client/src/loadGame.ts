import type * as GameModule from './game/Game.ts';
import { isStaleBuild, reloadOnce } from './ui/stale.ts';

/**
 * The game module (Three.js, Rapier: the large part), fetched once; the boot load starts it
 * as soon as the page opens. A failed download is forgotten, so a retry fetches it again.
 */
let gameModule: Promise<typeof GameModule> | null = null;
export const loadGame = (): Promise<typeof GameModule> =>
  (gameModule ??= import('./game/Game.ts').catch((e: unknown) => {
    gameModule = null;
    // An old page after a deploy: its code files are gone; a reload gets the current ones.
    if (isStaleBuild(e)) reloadOnce();
    throw e;
  }));
