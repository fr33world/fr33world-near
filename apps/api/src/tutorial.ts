/**
 * The tutorial's progress (shared TUTORIAL_STEPS): saved as the player goes, only ever forward,
 * so a resumed session carries on where it was. Finishing pays once per account (the tutorial
 * faucet, keyed by the account); skipping ends it without the reward.
 */
import {
  isTutorialStep,
  TUTORIAL_REWARD,
  TUTORIAL_STEPS,
  type TutorialStep,
} from '@fr33world/shared';
import type { Db } from './db.ts';
import { reward, type Rewarded } from './rewards.ts';

export class TutorialError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const order = (s: string) => TUTORIAL_STEPS.indexOf(s as (typeof TUTORIAL_STEPS)[number]);

export async function advanceTutorial(
  db: Db,
  privyUser: string,
  input: { step?: unknown },
): Promise<{ step: TutorialStep; reward: Rewarded | null }> {
  if (!isTutorialStep(input.step)) throw new TutorialError('Which step?');
  const r = await db.query<{ id: string; tutorial: TutorialStep }>(
    `select a.id, c.tutorial from accounts a join characters c on c.account_id = a.id
     where a.privy_user_id = $1`,
    [privyUser],
  );
  const me = r.rows[0];
  if (!me) throw new TutorialError('Make your character first.', 403);
  const over = me.tutorial === 'done' || me.tutorial === 'skipped';
  const wanted = input.step;
  if (over || (wanted !== 'skipped' && order(wanted) <= order(me.tutorial)))
    return { step: me.tutorial, reward: null };
  await db.query('update characters set tutorial = $2, updated_at = now() where account_id = $1', [
    me.id,
    wanted,
  ]);
  const paid =
    wanted === 'done'
      ? await reward(db, {
          account: me.id,
          source: 'tutorial',
          cents: TUTORIAL_REWARD.cents,
          xp: TUTORIAL_REWARD.xp,
          reason: 'Tutorial finished',
          key: `tutorial:${me.id}`,
        })
      : null;
  return { step: wanted, reward: paid };
}
