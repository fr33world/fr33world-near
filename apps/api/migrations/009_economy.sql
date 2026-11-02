-- Faucets and sinks as config (packages/shared economy.ts): the tutorial's faucet, and what the
-- caps read: a wallet's recent entries, by time.

insert into ledger_accounts (kind, code) values ('faucet', 'faucet:tutorial');

create index ledger_entries_by_account_time on ledger_entries (account_id, created_at);
