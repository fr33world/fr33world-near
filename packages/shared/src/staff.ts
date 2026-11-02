/**
 * Staff (Phase 4, owner 2026-10-30): the super admin (the owner) can do everything and makes
 * admins, each with only the powers given them. Carried in the world ticket; the world server
 * checks each chat command against them, and the API stores staff, bans and the audit log.
 */
export const STAFF_PERMISSIONS = {
  /** Move players: /goto, /bring, /unstuck, /tp. */
  teleport: 'Move players (unstick them, go to them, bring them)',
  /** Put stuck or misplaced cars right: /unstuckcar. */
  vehicles: 'Fix stuck cars',
  kick: 'Kick players',
  ban: 'Ban and unban players',
  /** Stop a player's chat for a while: /mute, /unmute. */
  mute: 'Mute players in chat',
  announce: 'Send announcements to everyone',
  /**
   * Put money right (Phase 5): add or take back with a reason, reverse a transaction, freeze
   * a wallet: /money, /reverse, /freeze, /thaw, /balance. Only compensating ledger entries.
   */
  money: 'Correct balances, reverse transactions, freeze wallets',
} as const;

export type StaffPermission = keyof typeof STAFF_PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(STAFF_PERMISSIONS) as StaffPermission[];

export interface Staff {
  role: 'super' | 'admin';
  permissions: StaffPermission[];
}

export const isPermission = (p: unknown): p is StaffPermission =>
  typeof p === 'string' && p in STAFF_PERMISSIONS;

/** Whether `staff` may use `permission` (the super admin may use everything). */
export function can(staff: Staff | null | undefined, permission: StaffPermission): boolean {
  return !!staff && (staff.role === 'super' || staff.permissions.includes(permission));
}
