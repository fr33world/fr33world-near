-- The tutorial's progress with the character (shared TUTORIAL_STEPS), so it resumes where it
-- was; 'done' or 'skipped' once over.
alter table characters add column tutorial text not null default 'welcome';
