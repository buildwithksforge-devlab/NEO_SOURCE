create table if not exists public.guest_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id uuid,
  customer_id uuid not null references public.customers(id) on delete cascade,
  category text not null,
  event_type text not null,
  title text not null,
  body text,
  link text,
  source_module text,
  source_record_id uuid,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create unique index if not exists guest_notifications_idem_key
  on public.guest_notifications (organization_id, idempotency_key);
create index if not exists guest_notifications_customer_idx
  on public.guest_notifications (customer_id, created_at desc);

grant select on public.guest_notifications to authenticated;
grant update (read_at) on public.guest_notifications to authenticated;
grant all on public.guest_notifications to service_role;

alter table public.guest_notifications enable row level security;

drop policy if exists guest_notifications_owner_read on public.guest_notifications;
create policy guest_notifications_owner_read
  on public.guest_notifications for select to authenticated
  using (exists (
    select 1 from public.customers c
    where c.id = guest_notifications.customer_id
      and c.auth_user_id = auth.uid()
  ));

drop policy if exists guest_notifications_owner_update on public.guest_notifications;
create policy guest_notifications_owner_update
  on public.guest_notifications for update to authenticated
  using (exists (
    select 1 from public.customers c
    where c.id = guest_notifications.customer_id
      and c.auth_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.customers c
    where c.id = guest_notifications.customer_id
      and c.auth_user_id = auth.uid()
  ));

drop policy if exists guest_notifications_staff_read on public.guest_notifications;
create policy guest_notifications_staff_read
  on public.guest_notifications for select to authenticated
  using (organization_id = public.current_org_id());

create or replace function public.neo_guest_notify(
  _org uuid, _branch uuid, _customer uuid, _category text, _event text,
  _title text, _body text, _link text, _module text, _record uuid, _idem text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare _id uuid;
begin
  if _org is null or _customer is null or _idem is null then
    return null;
  end if;
  insert into public.guest_notifications (
    organization_id, branch_id, customer_id, category, event_type,
    title, body, link, source_module, source_record_id, idempotency_key
  ) values (
    _org, _branch, _customer, _category, _event, _title, _body, _link, _module, _record, _idem
  )
  on conflict (organization_id, idempotency_key) do nothing
  returning id into _id;
  return _id;
end $$;

revoke execute on function public.neo_guest_notify(uuid,uuid,uuid,text,text,text,text,text,text,uuid,text) from public, anon, authenticated;

create or replace function public.neo_guest_notify_reservation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is null then return new; end if;

  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or coalesce(old.status, '') is distinct from 'confirmed') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'stay', 'booking_confirmed',
      'Booking confirmed',
      'Your stay ' || coalesce(new.confirmation_number, '') || ' is confirmed for ' || new.arrival_date || '.',
      case when new.confirmation_number is null then 'trips' else 'reservations/' || new.confirmation_number end,
      'pms', new.id, 'res-confirmed:' || new.id
    );
  end if;

  if new.room_id is not null
     and (tg_op = 'INSERT' or old.room_id is null)
     and new.status in ('confirmed', 'guaranteed')
     and new.arrival_date <= current_date + 1 then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'stay', 'checkin_ready',
      'Your room is ready',
      'Your room has been assigned. Reception can check you in.',
      case when new.confirmation_number is null then 'trips' else 'reservations/' || new.confirmation_number end,
      'pms', new.id, 'res-ready:' || new.id
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_guest_notify_reservation on public.reservations;
create trigger trg_guest_notify_reservation
  after insert or update of status, room_id on public.reservations
  for each row execute function public.neo_guest_notify_reservation();

create or replace function public.neo_guest_notify_pos_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is null then return new; end if;
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or coalesce(old.status, '') is distinct from 'confirmed') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'order', 'order_accepted',
      'Order accepted',
      'The kitchen has accepted order ' || coalesce(new.order_number, '') || '.',
      'orders', 'pos', new.id, 'pos-accepted:' || new.id
    );
  end if;
  return new;
end $$;

drop trigger if exists trg_guest_notify_pos_order on public.pos_orders;
create trigger trg_guest_notify_pos_order
  after insert or update of status on public.pos_orders
  for each row execute function public.neo_guest_notify_pos_order();

create or replace function public.neo_guest_notify_delivery_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is null then return new; end if;
  if new.order_status = 'confirmed'
     and (tg_op = 'INSERT' or coalesce(old.order_status, '') is distinct from 'confirmed') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'order', 'order_accepted',
      'Order accepted',
      'Order ' || coalesce(new.order_number, '') || ' has been accepted and is being prepared.',
      case when new.order_number is null then 'orders' else 'orders/' || new.order_number end,
      'delivery', new.id, 'delivery-accepted:' || new.id
    );
  end if;
  return new;
end $$;

drop trigger if exists trg_guest_notify_delivery_order on public.delivery_orders;
create trigger trg_guest_notify_delivery_order
  after insert or update of order_status on public.delivery_orders
  for each row execute function public.neo_guest_notify_delivery_order();

create or replace function public.neo_guest_notify_laundry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is null then return new; end if;
  if new.status = 'collected'
     and (tg_op = 'INSERT' or coalesce(old.status, '') is distinct from 'collected') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'laundry', 'laundry_collected',
      'Laundry collected',
      'Your laundry ' || coalesce(new.laundry_number, '') || ' has been collected.',
      'laundry', 'laundry', new.id, 'laundry-collected:' || new.id
    );
  end if;
  return new;
end $$;

drop trigger if exists trg_guest_notify_laundry on public.guest_laundry_orders;
create trigger trg_guest_notify_laundry
  after insert or update of status on public.guest_laundry_orders
  for each row execute function public.neo_guest_notify_laundry();

create or replace function public.neo_guest_my_hotels()
returns table (
  organization_id uuid,
  branch_id uuid,
  public_slug text,
  display_name text,
  cover_image_url text,
  stays bigint,
  last_activity date
)
language sql stable security definer set search_path = public as $$
  select e.organization_id,
         e.branch_id,
         e.public_slug,
         coalesce(e.display_name, b.name),
         e.cover_image_url,
         count(r.id),
         max(r.arrival_date)
  from public.customers c
  join public.neo_public_experience e on e.organization_id = c.organization_id
  join public.branches b on b.id = e.branch_id
  left join public.reservations r
    on r.customer_id = c.id and r.branch_id = e.branch_id
  where c.auth_user_id = auth.uid()
    and e.public_slug is not null
  group by e.organization_id, e.branch_id, e.public_slug, e.display_name, b.name, e.cover_image_url
  order by max(r.arrival_date) desc nulls last
$$;

grant execute on function public.neo_guest_my_hotels() to authenticated;