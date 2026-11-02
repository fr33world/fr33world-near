-- The ledger, finished from the old FreeWorld's (Phase 5):
--   * each transaction keeps a fingerprint of what was asked (kind, legs, memo), so an
--     idempotency key replayed with different amounts is refused, not quietly answered;
--   * each records who caused it ('system', 'account:<id>', 'staff:<id>');
--   * a wallet can be frozen (under review): it can still be paid, but nothing leaves it;
--   * corrections have their own faucet and sink, so they show apart from earnings and spending.

alter table ledger_transactions
  add column request_hash text,
  add column actor text not null default 'system';

alter table ledger_accounts add column frozen boolean not null default false;

-- Balances follow the entries; a frozen wallet refuses any debit.
create or replace function ledger_apply_entry() returns trigger language plpgsql as $$
declare
  is_frozen boolean;
begin
  update ledger_accounts set balance = balance + new.amount where id = new.account_id
    returning frozen into is_frozen;
  if is_frozen and new.amount < 0 then
    raise exception 'ledger account % is frozen', new.account_id
      using errcode = 'check_violation', constraint = 'account_frozen';
  end if;
  return new;
end $$;

-- Freezing changes no balance, so the guard lets it through; only `frozen` may change by hand.
insert into ledger_accounts (kind, code) values
  ('faucet', 'faucet:corrections'),
  ('sink', 'sink:corrections');
