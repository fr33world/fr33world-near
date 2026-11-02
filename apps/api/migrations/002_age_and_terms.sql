-- Age gate and Terms acceptance (decisions D-13, D-23): fr33world is 18+ only. The date of
-- birth is asked once after the first login and can't be changed afterwards, so nobody can
-- retry with a different year; an under-18 answer blocks the account for good.

alter table accounts
  add column birth_date date,
  add column age_checked_at timestamptz,
  -- Why the account may not play ('under_18', later moderation reasons).
  add column blocked_reason text,
  add column blocked_at timestamptz,
  add column terms_version text,
  add column terms_accepted_at timestamptz,
  add constraint birth_date_once check ((birth_date is null) = (age_checked_at is null)),
  add constraint blocked_with_time check ((blocked_reason is null) = (blocked_at is null));
