-- ROLE ISOLATION REPAIR 4: the guest table was readable by anyone holding any
-- module-wide "view" in delivery/restaurant/finance, which let riders,
-- waiters and procurement staff read the entire guest CRM.
drop policy if exists "staff read customers" on public.customers;
create policy "staff read customers"
  on public.customers for select to authenticated
  using (
    is_staff()
    and organization_id = current_org_id()
    and (
      is_org_admin()
      or has_permission('marketing','customers','view')
      or has_permission('front-office','guests','view')
      or has_permission('front-office','reservations','view')
      or has_permission('events','bookings','view')
    )
  );

-- A rider may read only the guests attached to a delivery currently assigned
-- to them.
drop policy if exists "rider reads assigned delivery customer" on public.customers;
create policy "rider reads assigned delivery customer"
  on public.customers for select to authenticated
  using (
    exists (
      select 1 from public.delivery_orders d
      where d.customer_id = customers.id
        and d.rider_id = public.my_rider_id()
        and (d.dispatch_status <> all (array['delivered','delivery-failed','returned'])
             or d.updated_at > now() - interval '24 hours')
    )
  );

-- Guest records may only be created or amended by staff with explicit CRM or
-- front-office guest authority.
drop policy if exists "staff update customers" on public.customers;
create policy "staff update customers"
  on public.customers for update to authenticated
  using (
    is_staff() and organization_id = current_org_id()
    and (is_org_admin()
         or has_permission('marketing','customers','edit')
         or has_permission('front-office','guests','edit')
         or has_permission('front-office','reservations','edit'))
  )
  with check (organization_id = current_org_id());

drop policy if exists "staff write customers" on public.customers;
create policy "staff write customers"
  on public.customers for insert to authenticated
  with check (
    is_staff() and organization_id = current_org_id()
    and (is_org_admin()
         or has_permission('marketing','customers','create')
         or has_permission('front-office','guests','create')
         or has_permission('front-office','reservations','create'))
  );