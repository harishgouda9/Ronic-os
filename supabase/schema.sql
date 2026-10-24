-- Ronic OS account and paid store.
-- Run this in the Supabase SQL editor. The desktop app uses the anon key only.
-- A listing stays in review until you set status to 'listed' with the service role.
-- Checkout is a separate HTTPS endpoint (VITE_STORE_CHECKOUT_URL). It must use the
-- service role to insert a purchases row and set status to 'paid' after Stripe confirms.
-- This file does not create a Stripe charge.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('skill', 'plugin', 'tool')),
  title text not null check (char_length(title) between 1 and 120),
  blurb text not null check (char_length(blurb) between 1 and 600),
  price_cents integer not null check (price_cents >= 0 and price_cents <= 100000000),
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'review' check (status in ('review', 'listed', 'removed')),
  created_at timestamptz not null default now()
);

create table if not exists public.listing_packs (
  listing_id uuid primary key references public.listings (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 200000)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  stripe_session_id text not null default '',
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.listing_packs enable row level security;
alter table public.purchases enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.listing_body(listing uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select pack.body
  from public.listing_packs pack
  join public.listings item on item.id = pack.listing_id
  where pack.listing_id = listing
    and (
      item.seller_id = auth.uid()
      or exists (
        select 1 from public.purchases purchase
        where purchase.listing_id = listing
          and purchase.buyer_id = auth.uid()
          and purchase.status = 'paid'
      )
    );
$$;

grant execute on function public.listing_body(uuid) to authenticated;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "read listed or own" on public.listings;
create policy "read listed or own" on public.listings
  for select to anon, authenticated
  using (status = 'listed' or seller_id = auth.uid());

drop policy if exists "sellers insert reviews" on public.listings;
create policy "sellers insert reviews" on public.listings
  for insert to authenticated
  with check (seller_id = auth.uid() and status = 'review');

drop policy if exists "sellers keep reviews" on public.listings;
create policy "sellers keep reviews" on public.listings
  for update to authenticated
  using (seller_id = auth.uid())
  with check (seller_id = auth.uid() and status = 'review');

drop policy if exists "sellers add packs" on public.listing_packs;
create policy "sellers add packs" on public.listing_packs
  for insert to authenticated
  with check (
    exists (
      select 1 from public.listings item
      where item.id = listing_id
        and item.seller_id = auth.uid()
        and item.status = 'review'
    )
  );

drop policy if exists "buyers read own purchases" on public.purchases;
create policy "buyers read own purchases" on public.purchases
  for select to authenticated using (buyer_id = auth.uid());
