import { quizFor, QUIZ } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyArms } from './armory.ts';
import type { Db } from './db.ts';
import {
  appointBoss,
  applyTo,
  decide,
  dismiss,
  factionStatus,
  fine,
  gangRank,
  idCard,
  setRank,
  takeQuiz,
} from './factions.ts';
import { inbox } from './inbox.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('factions');
});
afterAll(async () => {
  await db.end();
});

async function person(name: string, cents = 100) {
  n += 1;
  const privy = `did:privy:fac-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'F') returning id",
    [privy],
  );
  const id = (r.rows[0] as { id: string }).id;
  const full = `${name} Number${n}`;
  await db.query(
    'insert into characters (account_id, name, age, appearance) values ($1, $2, 31, 0)',
    [id, full],
  );
  await transfer(db, {
    kind: 'signup_bonus',
    key: `fund-${id}`,
    legs: [
      { account: await systemAccount(db, 'faucet:signup'), amount: -cents },
      { account: await walletOf(db, id), amount: cents },
    ],
  });
  return { privy, id, name: full };
}

/** The questions this applicant is being asked now. */
const quiz = async (privy: string) => {
  const a = (await factionStatus(db, privy)).application;
  if (!a) throw new Error('no application');
  return quizFor(a.faction, a.quizSeed);
};
const right = async (privy: string) => (await quiz(privy)).map((q) => q.answer);
const wrong = async (privy: string) =>
  (await quiz(privy)).map((q) => (q.answer + 1) % q.options.length);
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toThrow(re);
};

describe('factions', () => {
  it('takes an applicant through training and the interview to acceptance by a recruiter', async () => {
    const chief = await person('Chief');
    await appointBoss(db, { name: chief.name, faction: 'police', actor: 'admin' });
    const cadet = await person('Cadet');
    await applyTo(db, cadet.privy, { faction: 'police', note: ' I want to help ' });
    await rejects(applyTo(db, cadet.privy, { faction: 'medical' }), /already/);
    // Not before training.
    await rejects(decide(db, { actor: chief.id, name: cadet.name }), /training/);
    const failed = await takeQuiz(db, cadet.privy, { answers: await wrong(cadet.privy) });
    expect(failed.passed).toBe(false);
    await rejects(takeQuiz(db, cadet.privy, { answers: await right(cadet.privy) }), /later/);
    await db.query(
      `update applications set quiz_failed_at = now() - make_interval(secs => $2) where account_id = $1`,
      [cadet.id, QUIZ.retryMs / 1000 + 1],
    );
    expect((await takeQuiz(db, cadet.privy, { answers: await right(cadet.privy) })).passed).toBe(
      true,
    );
    // Someone without the power can't take them on.
    const officer = await person('Officer');
    await appointBoss(db, { name: officer.name, faction: 'police' });
    await db.query('update memberships set rank = 1 where account_id = $1', [officer.id]);
    await rejects(decide(db, { actor: officer.id, name: cadet.name }), /can’t take recruits/);
    expect(await decide(db, { actor: chief.id, name: cadet.name })).toMatchObject({
      accepted: true,
    });
    const status = await factionStatus(db, cadet.privy);
    expect(status.membership).toMatchObject({ faction: 'police', rank: 1, title: 'Cadet' });
    // The news waits in their inbox, read once.
    const box = await inbox(db, cadet.privy, true);
    expect(box.unread).toBe(1);
    expect(box.notices[0]?.text).toMatch(/welcome to Los Soles Police/);
    expect((await inbox(db, cadet.privy)).unread).toBe(0);
    // The chief sees the roster.
    expect((await factionStatus(db, chief.privy)).roster.map((r) => r.name)).toContain(cadet.name);
  });

  it('changes ranks only below the actor’s own, and dismisses', async () => {
    const boss = await person('Boss');
    await appointBoss(db, { name: boss.name, faction: 'vipers' });
    const lt = await person('Lt');
    await appointBoss(db, { name: lt.name, faction: 'vipers' });
    await db.query('update memberships set rank = 4 where account_id = $1', [lt.id]);
    const kid = await person('Kid');
    await appointBoss(db, { name: kid.name, faction: 'vipers' });
    await db.query('update memberships set rank = 1 where account_id = $1', [kid.id]);
    expect(await setRank(db, { actor: lt.id, name: kid.name, by: 1 })).toMatchObject({ rank: 2 });
    expect(await setRank(db, { actor: lt.id, name: kid.name, by: 1 })).toMatchObject({ rank: 3 });
    await rejects(setRank(db, { actor: lt.id, name: kid.name, by: 1 }), /your own rank/);
    await rejects(setRank(db, { actor: lt.id, name: boss.name, by: -1 }), /below you/);
    // Gang rank opens the black market.
    expect(await gangRank(db, kid.id)).toBe(3);
    await transfer(db, {
      kind: 'signup_bonus',
      key: `fund2-${kid.id}`,
      legs: [
        { account: await systemAccount(db, 'faucet:signup'), amount: -2_000_000 },
        { account: await walletOf(db, kid.id), amount: 2_000_000 },
      ],
    });
    const bought = await buyArms(db, gangRank, {
      account: kid.id,
      item: 'rifle',
      key: `r-${Date.now()}`,
      xp: 0,
    });
    expect(bought.arms.weapons).toContain(2);
    await rejects(dismiss(db, { actor: lt.id, name: boss.name }), /can’t dismiss|below you/);
    expect(await dismiss(db, { actor: boss.id, name: kid.name })).toMatchObject({ name: kid.name });
    expect(await gangRank(db, kid.id)).toBe(0);
  });

  it('lets police fine within bounds, and shows an ID', async () => {
    const cop = await person('Cop');
    await appointBoss(db, { name: cop.name, faction: 'police' });
    const driver = await person('Driver', 100_000);
    const key = () => `fine-${Date.now()}-${n++}`;
    await rejects(
      fine(db, { actor: cop.id, name: driver.name, cents: 10, reason: 'x', key: key() }),
      /Fines are/,
    );
    await rejects(
      fine(db, { actor: cop.id, name: driver.name, cents: 20_000, reason: '', key: key() }),
      /reason/,
    );
    await fine(db, {
      actor: cop.id,
      name: driver.name,
      cents: 20_000,
      reason: 'Speeding',
      key: key(),
    });
    expect(await balanceOf(db, await walletOf(db, driver.id))).toBe(80_000);
    const medic = await person('Medic');
    await appointBoss(db, { name: medic.name, faction: 'medical' });
    await rejects(
      fine(db, { actor: medic.id, name: driver.name, cents: 20_000, reason: 'x', key: key() }),
      /Only police/,
    );
    expect(await idCard(db, { name: cop.name })).toMatchObject({
      age: 31,
      licence: false,
      faction: 'LSP Chief',
    });
  });
});
