-- Run this once in the Supabase SQL editor for your project.
-- Dashboard → SQL → New query → paste → Run.

-- Public file bucket for shared .mxl scores
insert into storage.buckets (id, name, public)
values ('exchange', 'exchange', true)
on conflict (id) do update set public = excluded.public;

-- Shared catalog
create table if not exists public.exchange_scores (
  id text primary key,
  title text not null,
  composer text not null,
  credit text,
  filename text not null,
  format text not null default 'mxl',
  bytes integer not null default 0,
  added date not null default (timezone('utc', now()))::date,
  license text,
  storage_path text not null,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.exchange_scores enable row level security;

drop policy if exists "Public read exchange scores" on public.exchange_scores;
create policy "Public read exchange scores"
  on public.exchange_scores for select
  using (true);

drop policy if exists "Public insert exchange scores" on public.exchange_scores;
create policy "Public insert exchange scores"
  on public.exchange_scores for insert
  with check (true);

drop policy if exists "Public delete exchange scores" on public.exchange_scores;
create policy "Public delete exchange scores"
  on public.exchange_scores for delete
  using (true);

-- Storage access for the exchange bucket
drop policy if exists "Public read exchange files" on storage.objects;
create policy "Public read exchange files"
  on storage.objects for select
  using (bucket_id = 'exchange');

drop policy if exists "Public upload exchange files" on storage.objects;
create policy "Public upload exchange files"
  on storage.objects for insert
  with check (bucket_id = 'exchange');

drop policy if exists "Public update exchange files" on storage.objects;
create policy "Public update exchange files"
  on storage.objects for update
  using (bucket_id = 'exchange')
  with check (bucket_id = 'exchange');

drop policy if exists "Public delete exchange files" on storage.objects;
create policy "Public delete exchange files"
  on storage.objects for delete
  using (bucket_id = 'exchange');
