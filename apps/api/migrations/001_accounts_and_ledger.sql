-- Accounts and the `$` ledger (decision D-24: closed-loop, cheat-proof from the start).
--
-- Money is integer cents in a double-entry ledger. The database itself enforces the rules,
-- so a bug or an exploit in a game server can't break them:
--   * every transaction sums to zero (checked at commit): money only moves, never appears;
--   * a player's balance can't go below zero (CHECK on the maintained balance);
--   * entries are append-only (updates and deletes are refused);
--   * every transaction has a unique idempotency key, so a retried payment pays once.
-- Money enters only from `faucet` accounts (sign-up bonus, salaries, job pay) and leaves only
-- into `sink` accounts (fees, purchases from the game), which may go negative/positive freely:
-- minus the faucets' total is exactly the money ever created.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  -- Privy user id ("did:privy:...").
  privy_user_id text not null unique,
  display_name text not null check (length(display_name) between 1 and 24),
  is_guest boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create type ledger_kind as enum ('player', 'faucet', 'sink', 'escrow');

create table ledger_accounts (
  id bigserial primary key,
  kind ledger_kind not null,
  -- The player who owns a `player` account; system accounts have a code instead.
  owner_id uuid references accounts (id),
  code text unique,
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint owner_xor_code check ((owner_id is null) <> (code is null)),
  constraint players_have_owners check ((kind = 'player') = (owner_id is not null)),
  constraint no_overdraft check (kind in ('faucet', 'sink') or balance >= 0)
);
create unique index one_wallet_per_player on ledger_accounts (owner_id) where kind = 'player';

create table ledger_transactions (
  id bigserial primary key,
  -- What happened: 'signup_bonus', 'salary', 'car_purchase', 'trade', ...
  kind text not null,
  idempotency_key text not null unique,
  memo jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table ledger_entries (
  id bigserial primary key,
  tx_id bigint not null references ledger_transactions (id),
  account_id bigint not null references ledger_accounts (id),
  amount bigint not null check (amount <> 0),
  created_at timestamptz not null default now()
);
create index ledger_entries_by_account on ledger_entries (account_id, id);
create index ledger_entries_by_tx on ledger_entries (tx_id);

-- Balances follow the entries, in the same statement (so no_overdraft fires immediately).
create function ledger_apply_entry() returns trigger language plpgsql as $$
begin
  update ledger_accounts set balance = balance + new.amount where id = new.account_id;
  return new;
end $$;
create trigger ledger_entries_apply after insert on ledger_entries
  for each row execute function ledger_apply_entry();

-- Every transaction sums to zero, checked once all its entries are in (at commit).
create function ledger_check_balanced() returns trigger language plpgsql as $$
declare
  total bigint;
begin
  select coalesce(sum(amount), 0) into total from ledger_entries where tx_id = new.tx_id;
  if total <> 0 then
    raise exception 'ledger transaction % does not balance (off by %)', new.tx_id, total
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred
  for each row execute function ledger_check_balanced();

-- History is append-only.
create function ledger_refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'the ledger is append-only (% on %)', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function ledger_refuse_change();
create trigger ledger_transactions_append_only before update or delete on ledger_transactions
  for each row execute function ledger_refuse_change();

-- A balance only changes through ledger_apply_entry (trigger depth 2); a direct
-- `update ledger_accounts set balance = ...` (depth 1) is refused.
create function ledger_guard_balance() returns trigger language plpgsql as $$
begin
  if new.balance is distinct from old.balance and pg_trigger_depth() < 2 then
    raise exception 'balances change only through ledger entries'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger ledger_accounts_guard_balance before update on ledger_accounts
  for each row execute function ledger_guard_balance();

-- The game's own accounts.
insert into ledger_accounts (kind, code) values
  ('faucet', 'faucet:signup'),
  ('faucet', 'faucet:salary'),
  ('faucet', 'faucet:jobs'),
  ('sink', 'sink:fees'),
  ('sink', 'sink:purchases');
