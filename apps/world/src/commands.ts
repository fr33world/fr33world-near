/**
 * Chat commands (Phase 4, owner 2026-10-30): lines starting with "/" are commands, not chat.
 * Everyone has /help (calls the admins online) and /commands; staff have the commands their
 * powers allow (shared `STAFF_PERMISSIONS`), checked here against the staff role in their
 * ticket. Lasting changes (bans, staff) go to the API, which checks again; every staff action
 * goes to the audit log.
 */
import { can, type Staff, type StaffPermission } from '@fr33world/shared';

/** The API's internal routes staff commands use (apps/api app.ts). */
export type ApiPath =
  | 'goods/buy'
  | 'haul/finish'
  | 'ban'
  | 'staff'
  | 'staff/list'
  | 'money'
  | 'money/reverse'
  | 'money/freeze'
  | 'money/balance'
  | 'reward'
  | 'jobs/save'
  | 'jobs/load'
  | 'garage'
  | 'fare'
  | 'garage/condition'
  | 'arms'
  | 'arms/buy'
  | 'care/buy'
  | 'care/use'
  | 'arms/rounds'
  | 'kills'
  | 'place'
  | 'place/save'
  | 'faction'
  | 'faction/decide'
  | 'faction/interview'
  | 'faction/rank'
  | 'faction/dismiss'
  | 'faction/boss'
  | 'faction/fine'
  | 'faction/id';

const dollars = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** "500", "+500", "-250.50", "$1,000" → cents (signed), or NaN. */
export function parseCents(text: string | undefined): number {
  const m = /^([+-]?)\$?([\d,]+(?:\.\d{1,2})?)$/.exec((text ?? '').trim());
  if (!m) return Number.NaN;
  const cents = Math.round(Number((m[2] ?? '').replace(/,/g, '')) * 100);
  return m[1] === '-' ? -cents : cents;
}

/** What a command can see and do in the world (implemented by World). */
export interface CommandWorld {
  /** The player running it. */
  me: { id: number; name: string; account: string | null; staff: Staff | null };
  /** Online players by name (exact, case-insensitive; or the one name starting with it). */
  find(name: string): { id: number; name: string } | 'none' | 'many';
  /** Staff online (to notify), and where a player is (district and position). */
  staffOnline(): number[];
  whereIs(id: number): { district: string; x: number; z: number } | null;
  /** Messages: to one player, or to everyone. */
  tell(id: number, text: string): void;
  announce(text: string): void;
  /** Moving people and cars. */
  moveTo(id: number, x: number, z: number): void;
  moveNear(id: number, toId: number): void;
  unstick(id: number): void;
  unstickCar(id: number): string;
  /** Removes a player; `barMs` keeps their account out that long too (a ban). */
  kick(id: number, reason: string, barMs?: number): void;
  mute(id: number, minutes: number): void;
  /** Lets a banned account back onto this server. */
  unbar(account: string): void;
  /** Lasting changes, through the API; resolves to a message to show. */
  api(path: ApiPath, body: Record<string, unknown>): Promise<unknown>;
  audit(action: string, target: string, details?: string): void;
  /** Seconds since this player last asked for help. */
  helpCooldown(): number;
  markHelp(): void;
}

interface Command {
  usage: string;
  about: string;
  /** The power needed (none: anyone; 'super': the super admin only). */
  needs?: StaffPermission | 'super';
  run(w: CommandWorld, args: string[]): void | Promise<void>;
}

const HELP_EVERY_S = 60;

/** Splits a command line: `/ban "Ada Byron" 24 spam` or `/ban Ada Byron` (names have a space). */
export function parse(line: string): { name: string; args: string[] } {
  const parts: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.slice(1))) !== null) parts.push(m[1] ?? m[2] ?? '');
  return { name: (parts.shift() ?? '').toLowerCase(), args: parts };
}

/**
 * A player named at the start of `args` (character names are first and last: two words), and
 * what's left after it.
 */
function target(w: CommandWorld, args: string[]): { id: number; name: string; rest: string[] } {
  for (const take of [2, 1]) {
    if (args.length < take) continue;
    const found = w.find(args.slice(0, take).join(' '));
    if (typeof found === 'object') return { ...found, rest: args.slice(take) };
    if (found === 'many')
      throw new Error(`More than one player matches "${args.slice(0, take).join(' ')}".`);
  }
  throw new Error(
    args.length ? `No player online called "${args.slice(0, 2).join(' ')}".` : 'Which player?',
  );
}

const COMMANDS: Record<string, Command> = {
  help: {
    usage: '/help [what happened]',
    about: 'Call the admins online for help',
    run(w, args) {
      const wait = HELP_EVERY_S - w.helpCooldown();
      if (wait > 0) return w.tell(w.me.id, `You can ask for help again in ${Math.ceil(wait)} s.`);
      w.markHelp();
      const at = w.whereIs(w.me.id);
      const what = args.join(' ').slice(0, 120);
      const staff = w.staffOnline().filter((id) => id !== w.me.id);
      for (const id of staff)
        w.tell(
          id,
          `🆘 ${w.me.name} needs help${at ? ` in ${at.district}` : ''}${what ? `: ${what}` : ''}. /goto ${w.me.name}`,
        );
      w.audit('help', w.me.name, what);
      w.tell(
        w.me.id,
        staff.length
          ? `Help is on the way: ${staff.length} admin${staff.length > 1 ? 's' : ''} told.`
          : 'No admins are online right now. Your request was noted.',
      );
    },
  },
  commands: {
    usage: '/commands',
    about: 'List the commands you can use',
    run(w) {
      for (const c of Object.values(COMMANDS))
        if (allowed(w.me.staff, c)) w.tell(w.me.id, `${c.usage}: ${c.about}`);
    },
  },
  goto: {
    usage: '/goto <player>',
    about: 'Go to a player',
    needs: 'teleport',
    run(w, args) {
      const t = target(w, args);
      w.moveNear(w.me.id, t.id);
      w.audit('goto', t.name);
    },
  },
  bring: {
    usage: '/bring <player>',
    about: 'Bring a player to you',
    needs: 'teleport',
    run(w, args) {
      const t = target(w, args);
      w.moveNear(t.id, w.me.id);
      w.tell(t.id, `${w.me.name} (admin) brought you here.`);
      w.audit('bring', t.name);
    },
  },
  unstuck: {
    usage: '/unstuck <player>',
    about: 'Move a stuck player to the nearest open spot',
    needs: 'teleport',
    run(w, args) {
      const t = target(w, args);
      w.unstick(t.id);
      w.tell(t.id, `${w.me.name} (admin) moved you somewhere you can move again.`);
      w.tell(w.me.id, `${t.name} moved.`);
      w.audit('unstuck', t.name);
    },
  },
  tp: {
    usage: '/tp <x> <z>',
    about: 'Go to a place on the map',
    needs: 'teleport',
    run(w, args) {
      const [x, z] = args.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('Usage: /tp <x> <z>');
      w.moveTo(w.me.id, x as number, z as number);
      w.audit('tp', '', `${x}, ${z}`);
    },
  },
  unstuckcar: {
    usage: '/unstuckcar <player>',
    about: "Put a player's stuck car back on the road",
    needs: 'vehicles',
    run(w, args) {
      const t = target(w, args);
      w.tell(w.me.id, w.unstickCar(t.id));
      w.audit('unstuckcar', t.name);
    },
  },
  kick: {
    usage: '/kick <player> [reason]',
    about: 'Remove a player from the server',
    needs: 'kick',
    run(w, args) {
      const t = target(w, args);
      const reason = t.rest.join(' ').slice(0, 120);
      w.kick(t.id, reason);
      w.announce(`${t.name} was kicked by an admin.`);
      w.audit('kick', t.name, reason);
    },
  },
  ban: {
    usage: '/ban <player> [hours] [reason]',
    about: 'Ban a player (no hours: for good)',
    needs: 'ban',
    async run(w, args) {
      const t = target(w, args);
      const hours = Math.round(Number(t.rest[0]));
      const timed = Number.isFinite(hours) && hours > 0;
      const reason = (timed ? t.rest.slice(1) : t.rest).join(' ').slice(0, 120);
      await w.api('ban', { name: t.name, hours: timed ? hours : 0, reason });
      w.kick(
        t.id,
        `Banned${timed ? ` for ${hours} h` : ''}${reason ? `: ${reason}` : ''}`,
        timed ? hours * 3_600_000 : Infinity,
      );
      w.announce(`${t.name} was banned by an admin.`);
    },
  },
  unban: {
    usage: '/unban "<First Last>"',
    about: 'Lift a ban (the player need not be online)',
    needs: 'ban',
    async run(w, args) {
      const name = args.join(' ');
      if (!name) throw new Error('Usage: /unban "First Last"');
      const r = (await w.api('ban', { name, lift: true })) as { name: string; account: string };
      w.unbar(r.account);
      w.tell(w.me.id, `${r.name} can play again.`);
    },
  },
  mute: {
    usage: '/mute <player> [minutes]',
    about: "Stop a player's chat for a while (default 10 min)",
    needs: 'mute',
    run(w, args) {
      const t = target(w, args);
      const minutes = Math.min(24 * 60, Math.max(1, Number(t.rest[0]) || 10));
      w.mute(t.id, minutes);
      w.tell(t.id, `An admin muted your chat for ${minutes} min.`);
      w.tell(w.me.id, `${t.name} muted for ${minutes} min.`);
      w.audit('mute', t.name, `${minutes} min`);
    },
  },
  unmute: {
    usage: '/unmute <player>',
    about: "Give a player's chat back",
    needs: 'mute',
    run(w, args) {
      const t = target(w, args);
      w.mute(t.id, 0);
      w.tell(t.id, 'You can chat again.');
      w.tell(w.me.id, `${t.name} unmuted.`);
      w.audit('unmute', t.name);
    },
  },
  announce: {
    usage: '/announce <message>',
    about: 'Send a message to everyone',
    needs: 'announce',
    run(w, args) {
      const text = args.join(' ').slice(0, 200);
      if (!text) throw new Error('Usage: /announce <message>');
      w.announce(`📢 ${text}`);
      w.audit('announce', '', text);
    },
  },
  money: {
    usage: '/money "<First Last>" <+/-amount> <reason>',
    about: 'Add or take back money (a correction, with a reason)',
    needs: 'money',
    async run(w, args) {
      const [name, amount, ...why] = args;
      const cents = parseCents(amount);
      if (!name || !Number.isFinite(cents) || cents === 0)
        throw new Error('Usage: /money "First Last" +500 refund for lost car');
      const r = (await w.api('money', { name, cents, reason: why.join(' ') })) as {
        name: string;
        balance: number;
      };
      w.tell(w.me.id, `${r.name}: ${dollars(cents)} done. Balance ${dollars(r.balance)}.`);
      const online = w.find(r.name);
      if (typeof online === 'object')
        w.tell(
          online.id,
          `An admin ${cents > 0 ? 'added' : 'took back'} ${dollars(Math.abs(cents))}: ${why.join(' ')}`,
        );
    },
  },
  reverse: {
    usage: '/reverse <transaction number> <reason>',
    about: 'Undo a transaction (posts its mirror, once)',
    needs: 'money',
    async run(w, args) {
      const [tx, ...why] = args;
      const r = (await w.api('money/reverse', { tx: Number(tx), reason: why.join(' ') })) as {
        tx: number;
        kind: string;
      };
      w.tell(w.me.id, `Transaction ${r.tx} (${r.kind}) reversed.`);
    },
  },
  freeze: {
    usage: '/freeze "<First Last>" [reason]',
    about: "Freeze a player's wallet (they can be paid, can't spend)",
    needs: 'money',
    async run(w, args) {
      const [name, ...why] = args;
      const r = (await w.api('money/freeze', { name, frozen: true, reason: why.join(' ') })) as {
        name: string;
      };
      w.tell(w.me.id, `${r.name}'s wallet is frozen.`);
    },
  },
  thaw: {
    usage: '/thaw "<First Last>"',
    about: "Unfreeze a player's wallet",
    needs: 'money',
    async run(w, args) {
      const r = (await w.api('money/freeze', { name: args.join(' '), frozen: false })) as {
        name: string;
      };
      w.tell(w.me.id, `${r.name}'s wallet works again.`);
    },
  },
  balance: {
    usage: '/balance "<First Last>"',
    about: "A player's balance",
    needs: 'money',
    async run(w, args) {
      const r = (await w.api('money/balance', { name: args.join(' ') })) as {
        name: string;
        balance: number;
        frozen: boolean;
      };
      w.tell(w.me.id, `${r.name}: ${dollars(r.balance)}${r.frozen ? ' (frozen)' : ''}`);
    },
  },
  admin: {
    usage: '/admin add "<First Last>" <powers> | /admin remove "<First Last>"',
    about: `Make an admin, with powers from: teleport, vehicles, kick, ban, mute, announce, money`,
    needs: 'super',
    async run(w, args) {
      const [verb, ...rest] = args;
      if (verb !== 'add' && verb !== 'remove')
        throw new Error(
          'Usage: /admin add "First Last" kick,teleport  or  /admin remove "First Last"',
        );
      // The powers are the last word when adding (comma-separated); the name is the rest.
      const powers = verb === 'add' ? (rest.pop() ?? '').split(',').filter(Boolean) : [];
      const name = rest.join(' ');
      if (verb === 'add' && powers.length === 0)
        throw new Error('Which powers? e.g. kick,teleport');
      const r = (await w.api('staff', { name, permissions: powers })) as {
        name: string;
        permissions: string[];
      };
      w.tell(
        w.me.id,
        r.permissions.length
          ? `${r.name} is an admin: ${r.permissions.join(', ')}. (From their next login.)`
          : `${r.name} is no longer staff. (From their next login.)`,
      );
    },
  },
  staff: {
    usage: '/staff',
    about: 'List the admins and their powers',
    needs: 'super',
    async run(w) {
      const r = (await w.api('staff/list', {})) as {
        staff: { name: string; permissions: string[] }[];
      };
      if (!r.staff.length) w.tell(w.me.id, 'No admins yet. /admin add "First Last" kick,teleport');
      for (const s of r.staff) w.tell(w.me.id, `${s.name}: ${s.permissions.join(', ')}`);
    },
  },
};

function allowed(staff: Staff | null, c: Command): boolean {
  if (!c.needs) return true;
  if (c.needs === 'super') return staff?.role === 'super';
  return can(staff, c.needs);
}

/** Runs a chat line that starts with "/". */
export async function runCommand(w: CommandWorld, line: string): Promise<void> {
  const { name, args } = parse(line);
  const cmd = COMMANDS[name === '?' ? 'commands' : name];
  if (!cmd || !allowed(w.me.staff, cmd)) {
    w.tell(w.me.id, `Unknown command /${name}. /commands lists yours.`);
    return;
  }
  try {
    await cmd.run(w, args);
  } catch (e) {
    w.tell(w.me.id, e instanceof Error ? e.message : String(e));
  }
}
