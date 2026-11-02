-- Reports for random killing and car ramming (Phase 8): staff read them against the kill log.
alter table reports drop constraint if exists reports_reason_check;
alter table reports add constraint reports_reason_check
  check (reason in ('harassment', 'hate', 'cheating', 'spam', 'random_killing', 'car_ramming', 'other'));
