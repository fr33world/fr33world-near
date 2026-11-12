-- Test USDC claims from the public testnet faucet (usdc.ts `claimTestUsdc`). Kept so the limits
-- in shared TEST_USDC can be checked: per game account, per NEAR wallet and across everyone.
create table test_usdc_claims (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  near_account text not null,
  micro bigint not null check (micro > 0),
  tx text,
  at timestamptz not null default now()
);
create index test_usdc_claims_account on test_usdc_claims (account_id, at desc);
create index test_usdc_claims_near on test_usdc_claims (near_account, at desc);
create index test_usdc_claims_at on test_usdc_claims (at desc);
