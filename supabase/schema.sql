create table if not exists public.story_rooms (
  code text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.story_rooms enable row level security;
