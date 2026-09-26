-- Prevent new duplicate guest profiles per tenant on the two strong keys.
create unique index if not exists customers_org_phone_unique
  on public.customers (organization_id, regexp_replace(phone,'[^0-9+]','','g'))
  where phone <> '' and merged_into_id is null;

create unique index if not exists customers_org_email_unique
  on public.customers (organization_id, lower(email))
  where email <> '' and merged_into_id is null;