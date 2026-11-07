-- Private messages between characters (the phone's Messages app). Kept 30 days, like notices.
create table messages (
  id bigserial primary key,
  from_account uuid not null references accounts (id),
  to_account uuid not null references accounts (id),
  text text not null check (length(text) between 1 and 300),
  read boolean not null default false,
  at timestamptz not null default now()
);
create index messages_to on messages (to_account, id desc);
create index messages_from on messages (from_account, id desc);
