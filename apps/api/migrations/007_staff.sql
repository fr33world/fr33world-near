-- Staff (Phase 4): admins made by the super admin, each with chosen powers; bans; and the log
-- of everything staff do. The super admin is named by character in the API's SUPER_ADMINS
-- setting (so no one can make themselves one), not in this table.

create table staff (
  account_id uuid primary key references accounts (id),
  permissions text[] not null default '{}',
  added_by uuid references accounts (id),
  created_at timestamptz not null default now()
);

create table bans (
  account_id uuid primary key references accounts (id),
  until timestamptz,
  reason text not null default '',
  banned_by uuid references accounts (id),
  created_at timestamptz not null default now()
);

create table staff_audit (
  id bigserial primary key,
  actor uuid references accounts (id),
  action text not null,
  target text not null default '',
  details text not null default '',
  created_at timestamptz not null default now()
);
create index staff_audit_recent on staff_audit (created_at desc);
