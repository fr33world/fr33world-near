import { CARE, GANG, levelOf, QUIZ, quizFor } from '@fr33world/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armsOf, buyCare, useCare } from './armory.ts';
import type { Db } from './db.ts';
import {
  appointBoss,
  applyTo,
  decide,
  deskStatus,
  factionStatus,
  scheduleInterview,
  takeQuiz,
} from './factions.ts';
import {
  addGangPoints,
  board,
  createGang,
  decideMember,
  gangStatus,
  joinGang,
  leaveGang,
} from './gangs.ts';
import { balanceOf, systemAccount, transfer, walletOf } from './ledger.ts';
import { testDb } from './test-db.ts';

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await testDb('gangs');
});
afterAll(async () => {
  await db.end();
});

async function person(name: string, cents = 100, xp = 0, exact = false) {
  n += 1;
  const privy = `did:privy:gang-${Date.now()}-${n}`;
  const r = await db.query<{ id: string }>(
    "insert into accounts (privy_user_id, display_name) values ($1, 'G') returning id",
    [privy],
  );
  const id = (r.rows[0] as { id: string }).id;
  const full = exact ? name : `${name} Number${n}`;
  await db.query(
    'insert into characters (account_id, name, age, appearance, xp) values ($1, $2, 31, 0, $3)',
    [id, full, xp],
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

const rejects = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toThrow(re);
};
let enough = 0;
while (levelOf(enough).level < GANG.minLevel) enough += 100;
const rich = GANG.price + 100;
let tags = 0;
const tag = () => `T${(tags += 1)}`;

describe('gangs', () => {
  it('takes a level and the money to start one', async () => {
    const low = await person('Low', rich, 0);
    await rejects(createGang(db, low.privy, { name: 'Low Riders', tag: 'LOW' }), /level/);
    const poor = await person('Poor', 100, enough);
    await rejects(createGang(db, poor.privy, { name: 'Poor Boys', tag: 'POOR' }), /costs/);
    const ok = await person('Rich', rich, enough);
    const s = await createGang(db, ok.privy, { name: 'Sun Crew', tag: 'SUN' });
    expect(s.gang).toMatchObject({ name: 'Sun Crew', leader: true, accepted: true });
    expect(await balanceOf(db, await walletOf(db, ok.id))).toBe(100);
  });

  it('refuses taken and rude names', async () => {
    const a = await person('Taken', rich, enough);
    await createGang(db, a.privy, { name: 'Night Shift', tag: 'NITE' });
    const b = await person('Second', rich, enough);
    await rejects(createGang(db, b.privy, { name: 'night shift', tag: 'NS' }), /taken/);
    await rejects(createGang(db, b.privy, { name: 'Nazi Club', tag: 'NZ' }), /Not that name/);
    await rejects(createGang(db, b.privy, { name: 'X', tag: 'XX' }), /3 to 24/);
  });

  it('asks to join, the leader decides, and three make the board', async () => {
    const boss = await person('Boss', rich, enough);
    await createGang(db, boss.privy, { name: 'Harbour Rats', tag: tag() });
    const id = (await db.query<{ id: string }>("select id from gangs where name = 'Harbour Rats'"))
      .rows[0]?.id;
    const [a, b] = [await person('One'), await person('Two')];
    await joinGang(db, a.privy, { gang: id });
    await joinGang(db, b.privy, { gang: id });
    expect((await gangStatus(db, a.privy)).gang?.accepted).toBe(false);
    expect((await gangStatus(db, boss.privy)).gang?.requests).toHaveLength(2);
    await rejects(decideMember(db, a.privy, { name: b.name }), /leader/);
    await decideMember(db, boss.privy, { name: a.name });
    expect((await board(db)).some((r) => r.name === 'Harbour Rats')).toBe(false);
    await decideMember(db, boss.privy, { name: b.name });
    expect((await board(db)).some((r) => r.name === 'Harbour Rats')).toBe(true);
  });

  it('scores members’ jobs, and hands the gang on when its leader leaves', async () => {
    const boss = await person('Heir', rich, enough);
    await createGang(db, boss.privy, { name: 'Pier Pack', tag: tag() });
    const id = (await db.query<{ id: string }>("select id from gangs where name = 'Pier Pack'"))
      .rows[0]?.id;
    const [a, b] = [await person('Tre'), await person('Four')];
    for (const p of [a, b]) {
      await joinGang(db, p.privy, { gang: id });
      await decideMember(db, boss.privy, { name: p.name });
    }
    await addGangPoints(db as never, a.id, 7);
    expect((await board(db)).find((r) => r.name === 'Pier Pack')?.points).toBe(7);
    await leaveGang(db, boss.privy);
    expect((await gangStatus(db, a.privy)).gang?.leader).toBe(true);
  });

  it('keeps the gangs and the factions apart', async () => {
    const boss = await person('Apart', rich, enough);
    await createGang(db, boss.privy, { name: 'Lone Wolves', tag: tag() });
    await rejects(applyTo(db, boss.privy, { faction: 'police' }), /gang/);
    const cop = await person('Cop', rich, enough);
    await appointBoss(db, { name: cop.name, faction: 'police' });
    await rejects(createGang(db, cop.privy, { name: 'Blue Line', tag: tag() }), /faction/);
  });
});

describe('interviews', () => {
  const trained = async (name: string, faction: 'police' | 'medical') => {
    const p = await person(name);
    await applyTo(db, p.privy, { faction });
    const a = (await factionStatus(db, p.privy)).application;
    if (!a) throw new Error('no application');
    await takeQuiz(db, p.privy, { answers: quizFor(a.faction, a.quizSeed).map((q) => q.answer) });
    return p;
  };

  it('asks a fresh set of questions after a fail', async () => {
    const p = await person('Fresh');
    await applyTo(db, p.privy, { faction: 'police' });
    const a = (await factionStatus(db, p.privy)).application;
    if (!a) throw new Error('no application');
    expect(quizFor('police', a.quizSeed)).toHaveLength(QUIZ.size);
    await takeQuiz(db, p.privy, { answers: [] });
    expect((await factionStatus(db, p.privy)).application?.quizSeed).toBe(a.quizSeed + 1);
  });

  it('shows a boss their own applications, and lets them set the interview', async () => {
    const chief = await person('Chief');
    await appointBoss(db, { name: chief.name, faction: 'police' });
    const rookie = await trained('Rookie', 'police');
    const medic = await trained('Medic', 'medical');
    const desk = await deskStatus(db, chief.privy);
    expect(desk.factions).toEqual(['police']);
    expect(desk.applicants.map((a) => a.name)).toContain(rookie.name);
    expect(desk.applicants.map((a) => a.name)).not.toContain(medic.name);
    await rejects(
      scheduleInterview(db, { actor: chief.id, name: medic.name, minutes: 15 }),
      /isn’t yours/,
    );
    const set = await scheduleInterview(db, { actor: chief.id, name: rookie.name, minutes: 15 });
    expect(new Date(set.at).getTime()).toBeGreaterThan(Date.now());
    expect((await factionStatus(db, rookie.privy)).application?.interviewAt).toBe(set.at);
  });

  it('gives a member with no power an empty desk', async () => {
    const nobody = await person('Nobody');
    expect((await deskStatus(db, nobody.privy)).factions).toEqual([]);
  });

  it('lets David Horjet run every faction’s applications', async () => {
    const owner = await person('David Horjet', 100, 0, true);
    const rookie = await trained('Newbie', 'medical');
    expect((await deskStatus(db, owner.privy)).factions).toHaveLength(4);
    await scheduleInterview(db, { actor: owner.id, name: rookie.name, minutes: 60 });
    const r = await decide(db, { actor: owner.id, name: rookie.name, accept: true });
    expect(r).toMatchObject({ faction: 'medical', accepted: true });
    expect((await factionStatus(db, rookie.privy)).membership?.faction).toBe('medical');
  });
});

describe('the counter', () => {
  const bandage = CARE.items[0] as (typeof CARE.items)[number];

  it('charges more with no staff in, and carries a limit', async () => {
    const p = await person('Patient', 1_000_000);
    const a = await buyCare(db, {
      account: p.id,
      item: 'bandage',
      staffed: true,
      key: 'care-key-1',
    });
    expect(a.price).toBe(bandage.price);
    const b = await buyCare(db, {
      account: p.id,
      item: 'bandage',
      staffed: false,
      key: 'care-key-2',
    });
    expect(b.price).toBe(bandage.price * CARE.selfServe);
    for (let i = 3; i <= CARE.max; i += 1)
      await buyCare(db, { account: p.id, item: 'bandage', staffed: true, key: `care-key-${i}` });
    await rejects(
      buyCare(db, { account: p.id, item: 'bandage', staffed: true, key: 'care-key-99' }),
      /at most/,
    );
  });

  it('won’t sell what you can’t pay for, and using one takes it away', async () => {
    const poor = await person('Skint', 100);
    await rejects(
      buyCare(db, { account: poor.id, item: 'medicine', staffed: true, key: 'care-key-p' }),
      /Not enough/,
    );
    const p = await person('Used', 1_000_000);
    await buyCare(db, { account: p.id, item: 'medicine', staffed: true, key: 'care-key-u' });
    expect((await armsOf(db, p.id)).care?.medicine).toBe(1);
    await useCare(db, { account: p.id, item: 'medicine' });
    expect((await armsOf(db, p.id)).care?.medicine ?? 0).toBe(0);
  });
});
