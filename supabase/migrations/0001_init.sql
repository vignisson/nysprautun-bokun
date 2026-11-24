-- Nýsprautun tímabókanir — grunnskema
-- Ísland er alltaf UTC+0 (engin sumartímabreyting), en við geymum samt timestamptz.

create extension if not exists citext;

-- ---------------------------------------------------------------
-- Starfsfólk
-- ---------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email citext,
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Nýr auth-notandi fær prófíl sjálfkrafa (óvirkur þar til admin virkjar, nema sá fyrsti sem verður admin)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first boolean;
begin
  select not exists (select 1 from profiles) into first;
  insert into profiles (id, email, name, role, active)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
          case when first then 'admin' else 'staff' end,
          first);  -- aðrir verða virkir þegar admin býður þeim inn (worker /api/admin/invite)
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- Stillingar (ein röð)
-- ---------------------------------------------------------------
create table public.settings (
  id int primary key default 1 check (id = 1),
  shop_name text not null default 'Nýsprautun',
  shop_phone text default '',
  shop_email text default '',
  shop_address text default '',
  grid_start time not null default '07:00',
  grid_end time not null default '19:00',
  slot_minutes int not null default 15 check (slot_minutes in (5,10,15,20,30,60)),
  reminder_hour int not null default 16 check (reminder_hour between 0 and 23),
  sms_enabled boolean not null default false,
  email_enabled boolean not null default false,
  reminder_sms_template text not null default 'Aminning fra {verkstaedi}: {bilnumer} a tima {dagur} kl. {timi}. Simi {simi}.',
  ready_sms_template text not null default 'Bilinn thinn {bilnumer} er tilbuinn hja {verkstaedi}. Opid {opnunartimi}. Simi {simi}.',
  confirm_email_subject text not null default 'Tímabókun staðfest – {bilnumer}',
  confirm_email_body text not null default 'Sæl/l {nafn},\n\nTíminn þinn hjá {verkstaedi} er staðfestur: {dagur} kl. {timi} ({verk}).\nBílnúmer: {bilnumer}\n\nEf þú þarft að breyta tímanum, hringdu í {simi}.\n\nKveðja,\n{verkstaedi}',
  request_email_subject text not null default 'Beiðni um tíma móttekin – {bilnumer}',
  request_email_body text not null default 'Sæl/l {nafn},\n\nVið höfum móttekið beiðni þína um tíma ({verk}). Við höfum samband fljótlega til að staðfesta tímann.\n\nKveðja,\n{verkstaedi}',
  staff_notify_email text default '',
  online_booking_enabled boolean not null default true,
  online_min_days_ahead int not null default 1,
  online_max_days_ahead int not null default 60,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- Opnunartímar (1 = mánudagur … 7 = sunnudagur)
create table public.opening_hours (
  weekday int primary key check (weekday between 1 and 7),
  closed boolean not null default false,
  open_time time not null default '08:00',
  close_time time not null default '17:00'
);
insert into public.opening_hours (weekday, closed, open_time, close_time) values
  (1,false,'08:00','17:00'),(2,false,'08:00','17:00'),(3,false,'08:00','17:00'),
  (4,false,'08:00','17:00'),(5,false,'08:00','16:00'),(6,true,'10:00','14:00'),(7,true,'10:00','14:00');

-- ---------------------------------------------------------------
-- Lyftur og verktegundir
-- ---------------------------------------------------------------
create table public.lifts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0,
  color text not null default '#2563eb',
  active boolean not null default true,
  outlook_mailbox text,          -- netfang pósthólfsins sem á dagatalið
  outlook_calendar_id text,      -- id dagatalsins í Graph (tómt = sjálfgefið dagatal pósthólfsins)
  outlook_delta_link text,
  outlook_synced_at timestamptz,
  created_at timestamptz not null default now()
);
insert into public.lifts (name, sort, color) values
  ('Lyfta 1',1,'#2563eb'),('Lyfta 2',2,'#16a34a'),('Lyfta 3',3,'#d97706'),
  ('Lyfta 4',4,'#9333ea'),('Lyfta 5',5,'#dc2626');

create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_minutes int not null default 60 check (duration_minutes > 0),
  online_bookable boolean not null default true,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
insert into public.services (name, duration_minutes, sort) values
  ('Tjónaskoðun / mat', 30, 1),
  ('Smáviðgerð / blettun', 120, 2),
  ('Sprautun – heill dagur', 480, 3);

-- ---------------------------------------------------------------
-- Viðskiptavinir og bókanir
-- ---------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  phone text,
  email citext,
  notes text default '',
  created_at timestamptz not null default now()
);
create index customers_phone_idx on public.customers (phone);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null unique,
  description text default '',
  customer_id uuid references public.customers(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  lift_id uuid not null references public.lifts(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  service_id uuid references public.services(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  plate text default '',
  customer_name text default '',
  phone text default '',
  email citext,
  title text default '',
  notes text default '',
  status text not null default 'booked'
    check (status in ('booked','in_progress','ready','picked_up','cancelled','no_show')),
  source text not null default 'staff' check (source in ('staff','online','outlook')),
  send_reminder boolean not null default true,
  reminder_sent_at timestamptz,
  ready_sms_at timestamptz,
  confirm_email_at timestamptz,
  outlook_event_id text,
  outlook_lift_id uuid,          -- lyftan (dagatalið) sem Outlook-atburðurinn liggur í
  outlook_change_key text,
  outlook_synced_at timestamptz,
  outlook_dirty boolean not null default true,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index bookings_lift_time_idx on public.bookings (lift_id, starts_at);
create index bookings_time_idx on public.bookings (starts_at);
create unique index bookings_outlook_idx on public.bookings (outlook_event_id) where outlook_event_id is not null;

-- ---------------------------------------------------------------
-- Lokaðir tímar (t.d. hádegi). lift_id tómt = allar lyftur.
-- kind = 'weekly' (endurtekið á völdum vikudögum) eða 'once' (stakt tímabil)
-- ---------------------------------------------------------------
create table public.blocked_times (
  id uuid primary key default gen_random_uuid(),
  lift_id uuid references public.lifts(id) on delete cascade,
  kind text not null check (kind in ('weekly','once')),
  label text not null default 'Lokað',
  weekdays int[] default '{1,2,3,4,5}',
  start_time time,
  end_time time,
  valid_from date,
  valid_to date,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (kind = 'weekly' and start_time is not null and end_time is not null and end_time > start_time)
    or (kind = 'once' and starts_at is not null and ends_at is not null and ends_at > starts_at)
  )
);
insert into public.blocked_times (kind, label, weekdays, start_time, end_time)
values ('weekly','Hádegi','{1,2,3,4,5}','12:00','12:30');

-- Skarast tímabil [s,e) við lokaðan tíma fyrir lyftu?
create or replace function public.blocked_overlap(p_lift uuid, s timestamptz, e timestamptz)
returns text language plpgsql stable set search_path = public as $$
declare b record; d date; ds timestamptz; de timestamptz;
begin
  for b in select * from blocked_times where lift_id is null or lift_id = p_lift loop
    if b.kind = 'once' then
      if b.starts_at < e and b.ends_at > s then return b.label; end if;
    else
      d := (s at time zone 'Atlantic/Reykjavik')::date;
      while d <= (e at time zone 'Atlantic/Reykjavik')::date loop
        if extract(isodow from d)::int = any(b.weekdays)
           and (b.valid_from is null or d >= b.valid_from)
           and (b.valid_to is null or d <= b.valid_to) then
          ds := (d + b.start_time) at time zone 'Atlantic/Reykjavik';
          de := (d + b.end_time) at time zone 'Atlantic/Reykjavik';
          if ds < e and de > s then return b.label; end if;
        end if;
        d := d + 1;
      end loop;
    end if;
  end loop;
  return null;
end $$;

-- Bókun má ekki lenda á lokuðum tíma eða skarast við aðra bókun á sömu lyftu.
-- Bókanir sem koma úr Outlook eru ekki stöðvaðar (þær eru þegar í dagatalinu) heldur merktar.
create or replace function public.bookings_guard() returns trigger
language plpgsql set search_path = public as $$
declare lbl text; clash uuid;
begin
  new.updated_at := now();
  -- Breyting sem kemur úr Outlook setur nýjan change_key; þá er ekki ýtt aftur til Outlook.
  if tg_op = 'UPDATE' and (new.starts_at, new.ends_at, new.lift_id, new.title, new.plate, new.customer_name, new.notes, new.status, new.phone, new.service_id)
       is distinct from (old.starts_at, old.ends_at, old.lift_id, old.title, old.plate, old.customer_name, old.notes, old.status, old.phone, old.service_id)
     and new.outlook_change_key is not distinct from old.outlook_change_key then
    new.outlook_dirty := true;
  end if;
  if new.source = 'outlook' or new.status in ('cancelled','no_show') then return new; end if;
  if tg_op = 'UPDATE' and new.starts_at = old.starts_at and new.ends_at = old.ends_at and new.lift_id = old.lift_id then
    return new;
  end if;
  lbl := blocked_overlap(new.lift_id, new.starts_at, new.ends_at);
  if lbl is not null then
    raise exception 'BLOCKED:%', lbl using errcode = 'P0001';
  end if;
  select id into clash from bookings
   where lift_id = new.lift_id and id <> new.id and status not in ('cancelled','no_show')
     and starts_at < new.ends_at and ends_at > new.starts_at limit 1;
  if clash is not null then
    raise exception 'OVERLAP:%', clash using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger bookings_guard before insert or update on public.bookings
  for each row execute function public.bookings_guard();

-- ---------------------------------------------------------------
-- Netbókunarbeiðnir
-- ---------------------------------------------------------------
create table public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email citext,
  plate text not null,
  service_id uuid references public.services(id) on delete set null,
  preferred_date date,
  preferred_part text default 'any' check (preferred_part in ('any','morning','afternoon')),
  alt_date date,
  notes text default '',
  status text not null default 'new' check (status in ('new','accepted','declined')),
  booking_id uuid references public.bookings(id) on delete set null,
  handled_by uuid references public.profiles(id),
  handled_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Gulir miðar (eins og sticky_notes í John Tailor)
-- ---------------------------------------------------------------
create table public.sticky_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) default auth.uid(),
  day date not null,
  lift_id uuid references public.lifts(id) on delete set null,
  minute int not null default 600,
  body text not null default '',
  color text not null default 'yellow',
  done boolean not null default false,
  remind_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sticky_day_idx on public.sticky_notes (day);

-- ---------------------------------------------------------------
-- Skilaboðaskrá
-- ---------------------------------------------------------------
create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete set null,
  request_id uuid references public.booking_requests(id) on delete set null,
  channel text not null check (channel in ('sms','email')),
  kind text not null,
  to_addr text not null,
  body text,
  status text not null default 'sent',
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- RLS: allt lokað nema fyrir virkt starfsfólk. Netbókun fer í gegnum worker (service role).
-- ---------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.opening_hours enable row level security;
alter table public.lifts enable row level security;
alter table public.services enable row level security;
alter table public.customers enable row level security;
alter table public.vehicles enable row level security;
alter table public.bookings enable row level security;
alter table public.blocked_times enable row level security;
alter table public.booking_requests enable row level security;
alter table public.sticky_notes enable row level security;
alter table public.message_log enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (is_staff() or id = auth.uid());
create policy profiles_admin on public.profiles for update to authenticated using (is_admin()) with check (is_admin());

-- Lesaðgangur starfsfólks, skrif eingöngu admin fyrir stillingar
do $$
declare t text;
begin
  foreach t in array array['settings','opening_hours','lifts','services','blocked_times'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (is_staff())', t);
    execute format('create policy %1$s_admin on public.%1$s for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
  foreach t in array array['customers','vehicles','bookings','booking_requests','sticky_notes'] loop
    execute format('create policy %1$s_staff on public.%1$s for all to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;
create policy message_log_read on public.message_log for select to authenticated using (is_staff());

-- Realtime fyrir dagatalið
alter publication supabase_realtime add table public.bookings, public.sticky_notes, public.booking_requests, public.blocked_times;
