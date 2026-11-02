-- The invariant monitor's switch and log (technical-plan §7.5). When a check finds the books
-- wrong it pauses the economy: from then the database refuses every new transaction except an
-- admin's correction, until someone resumes it.

create table economy_control (
  id int primary key default 1 check (id = 1),
  paused_at timestamptz,
  reason text,
  resumed_by text,
  resumed_at timestamptz
);
insert into economy_control (id) values (1);

create table economy_alerts (
  id bigserial primary key,
  kind text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create function ledger_refuse_while_paused() returns trigger language plpgsql as $$
begin
  if new.kind <> 'correction' and exists (select 1 from economy_control where paused_at is not null) then
    raise exception 'the economy is paused'
      using errcode = 'check_violation', constraint = 'economy_paused';
  end if;
  return new;
end $$;
create trigger ledger_transactions_paused before insert on ledger_transactions
  for each row execute function ledger_refuse_while_paused();
