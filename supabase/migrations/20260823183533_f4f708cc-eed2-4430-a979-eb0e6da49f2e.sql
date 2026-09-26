-- CRM REPAIR 2: guest interactions raised against a folio, stay or reservation
-- must resolve back to the unified guest profile so Guest 360 is complete.
create or replace function public.neo_link_guest_from_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_customer uuid;
begin
  if new.customer_id is not null then
    -- always follow a merge chain to the surviving profile
    select coalesce(c.merged_into_id, c.id) into v_customer from public.customers c where c.id = new.customer_id;
    new.customer_id := coalesce(v_customer, new.customer_id);
    return new;
  end if;

  if to_jsonb(new) ? 'folio_id' and (to_jsonb(new)->>'folio_id') is not null then
    select f.customer_id into v_customer from public.folios f where f.id = (to_jsonb(new)->>'folio_id')::uuid;
  end if;
  if v_customer is null and to_jsonb(new) ? 'reservation_id' and (to_jsonb(new)->>'reservation_id') is not null then
    select r.customer_id into v_customer from public.reservations r where r.id = (to_jsonb(new)->>'reservation_id')::uuid;
  end if;
  if v_customer is null and to_jsonb(new) ? 'stay_id' and (to_jsonb(new)->>'stay_id') is not null then
    select s.customer_id into v_customer from public.stays s where s.id = (to_jsonb(new)->>'stay_id')::uuid;
  end if;

  if v_customer is not null then
    select coalesce(c.merged_into_id, c.id) into v_customer from public.customers c where c.id = v_customer;
    new.customer_id := v_customer;
  end if;
  return new;
end $$;

drop trigger if exists trg_link_guest_laundry on public.guest_laundry_orders;
create trigger trg_link_guest_laundry
  before insert or update of folio_id, reservation_id, customer_id on public.guest_laundry_orders
  for each row execute function public.neo_link_guest_from_context();

drop trigger if exists trg_link_guest_pos on public.pos_orders;
create trigger trg_link_guest_pos
  before insert or update of folio_id, stay_id, customer_id on public.pos_orders
  for each row execute function public.neo_link_guest_from_context();

-- Backfill existing rows that already carry a folio/stay/reservation link.
update public.guest_laundry_orders o
   set customer_id = f.customer_id
  from public.folios f
 where o.customer_id is null and o.folio_id = f.id and f.customer_id is not null;

update public.guest_laundry_orders o
   set customer_id = r.customer_id
  from public.reservations r
 where o.customer_id is null and o.reservation_id = r.id and r.customer_id is not null;

update public.pos_orders o
   set customer_id = f.customer_id
  from public.folios f
 where o.customer_id is null and o.folio_id = f.id and f.customer_id is not null;

update public.pos_orders o
   set customer_id = s.customer_id
  from public.stays s
 where o.customer_id is null and o.stay_id = s.id and s.customer_id is not null;