-- Ronic OS — account, licensing & revenue schema (v2) + marketplace store.
-- Run in the Supabase SQL editor. The desktop app uses the anon key only.
-- All money/inventory mutations happen through SECURITY DEFINER RPCs that
-- trust the SUPABASE_SERVICE_ROLE_KEY (Vercel webhooks + Edge Functions).
--
-- Layout:
--   identity     profiles, device_activations
--   revenue      licenses, founder_pass_pool, compute_wallets, billing_events
--   compute      ghost_runners
--   store        listings, listing_packs, purchases (marketplace, unchanged)

create extension if not exists pgcrypto;

-- =====================================================================
-- IDENTITY
-- =====================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  founder_badge_number integer check (founder_badge_number between 1 and 500),
  referral_code text unique not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists email text not null default '',
  add column if not exists full_name text not null default '',
  add column if not exists founder_badge_number integer check (founder_badge_number between 1 and 500),
  add column if not exists referral_code text unique not null default '';

-- =====================================================================
-- REVENUE
-- =====================================================================

-- One row per user. Clients can SELECT it; only the service role (billing
-- webhooks and the lease signer) ever writes plan_tier or the lease blob.
create table if not exists public.licenses (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_tier text not null default 'free'
    check (plan_tier in ('free', 'pro', 'founder_lifetime', 'team')),
  status text not null default 'active' check (status in ('active', 'past_due', 'canceled')),
  max_devices integer not null default 1 check (max_devices between 1 and 10),
  ed25519_lease jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Singleton inventory counter for the 500 Founder Passes. The claim RPC
-- increments claimed_count inside a serializable transaction so two
-- simultaneous checkouts can never both win seat 500.
create table if not exists public.founder_pass_pool (
  id integer primary key default 1 check (id = 1),
  max_supply integer not null default 500,
  claimed_count integer not null default 0,
  price_usd integer not null default 14900,   -- cents: $149.00
  price_inr integer not null default 1199900, -- paise: ₹11,999.00
  opened_at timestamptz not null default now()
);
insert into public.founder_pass_pool (id) values (1) on conflict (id) do nothing;

-- Hardware seats. register_device() enforces COUNT(*) <= licenses.max_devices.
create table if not exists public.device_activations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  hardware_hash text not null,                -- salted SHA-256 from the desktop
  device_name text not null default '',
  os_platform text not null default '',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, hardware_hash)
);

-- Prepaid Burst Compute & Ghost Runner credits. $1.00 == 1_000_000 micro_usd,
-- BIGINT so there is no floating-point drift, ever.
create table if not exists public.compute_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance_micro_usd bigint not null default 0 check (balance_micro_usd >= 0),
  auto_reload_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Idempotency ledger for the billing webhook. Every processed payment event
-- stores its provider event id here; replays are no-ops.
create table if not exists public.billing_events (
  provider text not null check (provider in ('stripe', 'razorpay', 'x402')),
  event_id text not null,
  processed_at timestamptz not null default now(),
  primary key (provider, event_id)
);

-- =====================================================================
-- COMPUTE (24/7 cloud ghost runners)
-- =====================================================================

create table if not exists public.ghost_runners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bot_handle text not null,
  vm_region text not null default 'eu-central',
  container_id text not null default '',
  status text not null default 'queued'
    check (status in ('queued', 'booting', 'running', 'stopped', 'failed')),
  hourly_rate_micro_usd bigint not null default 8000, -- $0.008/hr
  created_at timestamptz not null default now(),
  last_billed_at timestamptz
);

-- =====================================================================
-- STORE (marketplace packs — unchanged from v1)
-- =====================================================================

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

-- =====================================================================
-- TRIGGERS
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, referral_code)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), ''),
    -- Short, unique-enough referral code; collisions fail the insert loudly
    -- rather than silently issuing two founders the same code.
    substr(replace(new.id::text, '-', ''), 1, 10)
  )
  on conflict (id) do nothing;

  insert into public.licenses (user_id, plan_tier, max_devices)
  values (new.id, 'free', 1)
  on conflict (user_id) do nothing;

  insert into public.compute_wallets (user_id, balance_micro_usd)
  values (new.id, 0)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- RPCs (service-role only — revoke from anon/authenticated below)
-- =====================================================================

-- Atomically claim one of the 500 Founder Passes and mint founder badge #.
create or replace function public.claim_founder_pass(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  badge integer;
begin
  insert into public.billing_events (provider, event_id)
    values ('stripe', 'founder:' || p_user_id::text)
    on conflict (provider, event_id) do nothing;
  if found = false then
    -- Already claimed once by this user: idempotent replay.
    select founder_badge_number into badge from public.profiles where id = p_user_id;
    return coalesce(badge, 0);
  end if;

  update public.founder_pass_pool
     set claimed_count = claimed_count + 1
   where id = 1 and claimed_count < max_supply
  returning claimed_count into badge;
  if badge is null then
    raise exception 'FOUNDER_POOL_EXHAUSTED';
  end if;

  update public.profiles set founder_badge_number = badge where id = p_user_id;
  update public.licenses
     set plan_tier = 'founder_lifetime', status = 'active', max_devices = 3, updated_at = now()
   where user_id = p_user_id;
  return badge;
end;
$$;

-- Set/clear a subscription tier (Pro monthly/yearly, cancellations).
create or replace function public.activate_subscription(p_user_id uuid, p_tier text, p_max_devices integer, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A Founder Pass is lifetime; a later Stripe subscription event must never
  -- downgrade it back to pro.
  if exists (select 1 from public.licenses where user_id = p_user_id and plan_tier = 'founder_lifetime')
     and p_tier <> 'founder_lifetime' then
    return;
  end if;
  insert into public.licenses (user_id, plan_tier, max_devices, status, updated_at)
  values (p_user_id, p_tier, p_max_devices, p_status, now())
  on conflict (user_id) do update
    set plan_tier = excluded.plan_tier,
        max_devices = excluded.max_devices,
        status = excluded.status,
        updated_at = now();
end;
$$;

-- Register this machine as a seat; enforces the plan's device cap.
create or replace function public.register_device(
  p_user_id uuid,
  p_hardware_hash text,
  p_device_name text,
  p_os_platform text
)
returns text  -- 'registered' | 'already'
language plpgsql
security definer
set search_path = public
as $$
declare
  maxd integer;
  seats integer;
begin
  -- SECURITY DEFINER ignores RLS, so the caller identity is checked here.
  if p_user_id <> auth.uid() then
    raise exception 'FORBIDDEN: can only register your own devices';
  end if;

  -- One user registering two laptops at once must not both pass the cap.
  perform pg_advisory_xact_lock(hashtext('devices:' || p_user_id::text));

  select max_devices into maxd from public.licenses where user_id = p_user_id;
  if maxd is null then
    insert into public.licenses (user_id, plan_tier, max_devices) values (p_user_id, 'free', 1);
    maxd := 1;
  end if;

  select count(*) into seats
    from public.device_activations
   where user_id = p_user_id and hardware_hash = p_hardware_hash;
  if seats > 0 then
    update public.device_activations
       set last_seen_at = now(), device_name = p_device_name, os_platform = p_os_platform
     where user_id = p_user_id and hardware_hash = p_hardware_hash;
    return 'already';
  end if;

  select count(*) into seats from public.device_activations where user_id = p_user_id;
  if seats >= maxd then
    raise exception 'DEVICE_LIMIT:%', maxd;
  end if;

  insert into public.device_activations (user_id, hardware_hash, device_name, os_platform)
  values (p_user_id, p_hardware_hash, p_device_name, p_os_platform);
  return 'registered';
end;
$$;

create or replace function public.revoke_device(p_user_id uuid, p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id <> auth.uid() then
    raise exception 'FORBIDDEN: can only revoke your own devices';
  end if;
  delete from public.device_activations
   where id = p_device_id and user_id = p_user_id;
end;
$$;

-- Idempotent bootstrap so a pre-existing auth user gets license/wallet rows
-- before their first lease refresh.
create or replace function public.ensure_user_rows(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id <> auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.licenses (user_id, plan_tier, max_devices) values (p_user_id, 'free', 1)
  on conflict (user_id) do nothing;
  insert into public.compute_wallets (user_id, balance_micro_usd) values (p_user_id, 0)
  on conflict (user_id) do nothing;
end;
$$;

-- Wallet mutations are always whole micro-USD integers.
create or replace function public.credit_wallet(p_user_id uuid, p_micro_usd bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  bal bigint;
begin
  insert into public.compute_wallets (user_id, balance_micro_usd)
  values (p_user_id, p_micro_usd)
  on conflict (user_id) do update
    set balance_micro_usd = public.compute_wallets.balance_micro_usd + p_micro_usd,
        updated_at = now()
  returning balance_micro_usd into bal;
  return bal;
end;
$$;

create or replace function public.debit_wallet(p_user_id uuid, p_micro_usd bigint, p_min_balance bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  bal bigint;
begin
  update public.compute_wallets
     set balance_micro_usd = balance_micro_usd - p_micro_usd,
         updated_at = now()
   where user_id = p_user_id and balance_micro_usd - p_micro_usd >= p_min_balance
  returning balance_micro_usd into bal;
  if bal is null then
    -- Either no wallet row or insufficient balance; distinguish for billing.
    select balance_micro_usd into bal from public.compute_wallets where user_id = p_user_id;
    if bal is null then
      raise exception 'WALLET_MISSING';
    end if;
    raise exception 'WALLET_INSUFFICIENT:%', bal;
  end if;
  return bal;
end;
$$;

-- Ghost runner lifecycle bookkeeping (the orchestrator worker calls this).
create or replace function public.set_ghost_runner_status(
  p_runner_id uuid,
  p_status text,
  p_container_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ghost_runners
     set status = p_status,
         container_id = coalesce(p_container_id, container_id)
   where id = p_runner_id;
end;
$$;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.licenses enable row level security;
alter table public.founder_pass_pool enable row level security;
alter table public.device_activations enable row level security;
alter table public.compute_wallets enable row level security;
alter table public.billing_events enable row level security;
alter table public.ghost_runners enable row level security;
alter table public.listings enable row level security;
alter table public.listing_packs enable row level security;
alter table public.purchases enable row level security;

-- profiles: read/update your own row (badge number is set only by the RPC).
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid())
  with check (id = auth.uid() and founder_badge_number = (select p.founder_badge_number from public.profiles p where p.id = auth.uid()));

-- licenses: read-only mirror of what billing decided.
drop policy if exists "read own license" on public.licenses;
create policy "read own license" on public.licenses
  for select to authenticated using (user_id = auth.uid());

-- founder pool: anyone can see how many passes remain (store page counter).
drop policy if exists "read founder pool" on public.founder_pass_pool;
create policy "read founder pool" on public.founder_pass_pool
  for select to anon, authenticated using (true);

-- devices: users see and revoke their own seats; registration goes through
-- the register_device RPC so the cap cannot be bypassed with a plain INSERT.
drop policy if exists "read own devices" on public.device_activations;
create policy "read own devices" on public.device_activations
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "delete own devices" on public.device_activations;
create policy "delete own devices" on public.device_activations
  for delete to authenticated using (user_id = auth.uid());

-- wallets: read your own balance; mutations only via the RPCs.
drop policy if exists "read own wallet" on public.compute_wallets;
create policy "read own wallet" on public.compute_wallets
  for select to authenticated using (user_id = auth.uid());

-- ghost runners: read your own fleet-in-the-cloud rows.
drop policy if exists "read own ghost runners" on public.ghost_runners;
create policy "read own ghost runners" on public.ghost_runners
  for select to authenticated using (user_id = auth.uid());

-- billing_events: no client access at all (service role only, default deny).

-- store (unchanged from v1)
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

drop policy if exists "sellers insert reviews" on public.listings;
create policy "sellers insert reviews" on public.listings
  for insert to authenticated
  with check (seller_id = auth.uid() and status = 'review');

drop policy if exists "sellers keep reviews" on public.listings;
create policy "sellers keep reviews" on public.listings
  for update to authenticated
  using (seller_id = auth.uid())
  with check (seller_id = auth.uid() and status = 'review');

drop policy if exists "read listed or own" on public.listings;
create policy "read listed or own" on public.listings
  for select to anon, authenticated
  using (status = 'listed' or seller_id = auth.uid());

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

-- Money and inventory RPCs are service-role only. The desktop never calls
-- them; the Vercel webhooks and the lease signer do.
revoke execute on function public.claim_founder_pass(uuid) from anon, authenticated;
revoke execute on function public.activate_subscription(uuid, text, integer, text) from anon, authenticated;
revoke execute on function public.credit_wallet(uuid, bigint) from anon, authenticated;
revoke execute on function public.debit_wallet(uuid, bigint, bigint) from anon, authenticated;
revoke execute on function public.set_ghost_runner_status(uuid, text, text) from anon, authenticated;
-- register_device/revoke_device/ensure_user_rows run with the caller's JWT;
-- each asserts p_user_id = auth.uid() inside the SECURITY DEFINER body:
grant execute on function public.register_device(uuid, text, text, text) to authenticated;
grant execute on function public.revoke_device(uuid, uuid) to authenticated;
grant execute on function public.ensure_user_rows(uuid) to authenticated;
