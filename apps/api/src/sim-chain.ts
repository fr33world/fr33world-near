/* eslint-disable @typescript-eslint/require-await -- this stand-in chain answers at once */
/**
 * The wallet contract's rules in memory, for tests and the week-in-a-minute run. The real thing
 * is contracts/business-wallet, proved on testnet by packages/chain smoke.ts.
 */
import type { EconomyChain } from './business.ts';

/** The wallet contract's rules, in memory. */
export class SimChain implements EconomyChain {
  wallets = new Map<string, { balance: number; reserved: number }>();
  orders = new Map<string, { status: string }>();
  jobs = new Map<string, { status: string; amount: number; wallet: string; worker?: string }>();
  paidTo = new Map<string, number>();
  failNext = 0;
  private n = 0;
  accountOf = (short: string) => `${short}.test`;
  private w(id: string) {
    let w = this.wallets.get(id);
    if (!w) this.wallets.set(id, (w = { balance: 0, reserved: 0 }));
    return w;
  }
  private sent() {
    this.n += 1;
    return { tx: `tx${this.n}` };
  }
  fund(wallet: string, amount: number) {
    this.w(wallet).balance += amount;
  }
  async summary(id: string) {
    const w = this.w(id);
    return { balance: String(w.balance), reserved: String(w.reserved) };
  }
  async getOrder(_w: string, id: string) {
    return this.orders.get(id) ?? null;
  }
  async getJob(_w: string, id: string) {
    return this.jobs.get(id) ?? null;
  }
  async paySupplier(wallet: string, id: string, to: string, amount: number) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('rpc timeout');
    }
    const w = this.w(wallet);
    if (this.orders.has(id)) throw new Error('order already exists');
    if (amount > w.balance - w.reserved) throw new Error('not enough free balance');
    w.balance -= amount;
    this.w(to).balance += amount;
    this.orders.set(id, { status: 'paid' });
    return this.sent();
  }
  async postJob(wallet: string, id: string, amount: number) {
    const w = this.w(wallet);
    if (amount > w.balance - w.reserved) throw new Error('not enough free balance');
    w.reserved += amount;
    this.jobs.set(id, { status: 'open', amount, wallet });
    return this.sent();
  }
  async assignJob(_w: string, id: string, worker: string) {
    const j = this.jobs.get(id)!;
    j.status = 'assigned';
    j.worker = worker;
    return this.sent();
  }
  async releaseJob(wallet: string, id: string) {
    const j = this.jobs.get(id)!;
    const w = this.w(wallet);
    w.reserved -= j.amount;
    w.balance -= j.amount;
    this.paidTo.set(j.worker!, (this.paidTo.get(j.worker!) ?? 0) + j.amount);
    j.status = 'paid';
    return this.sent();
  }
  async cancelJob(wallet: string, id: string) {
    const j = this.jobs.get(id)!;
    this.w(wallet).reserved -= j.amount;
    j.status = 'cancelled';
    return this.sent();
  }
}
