create table reservations(id uuid primary key,organization_id uuid,branch_id uuid,customer_id uuid,status text default 'confirmed',total_amount numeric default 15000,deposit_required numeric default 5000,deposit_paid numeric default 0,payment_status text default 'unpaid',balance numeric default 15000,updated_at timestamptz);
create table reservation_deposits(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,reservation_id uuid,customer_id uuid,amount numeric,currency text default 'KES',method text,status text default 'held',reference text,payment_id uuid,received_by uuid,idempotency_key text,notes text,applied_folio_id uuid,applied_folio_line_id uuid,applied_at timestamptz,unique(organization_id,idempotency_key));
create table folio_lines(id uuid primary key default gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,reservation_id uuid,line_type text default 'charge',category text default 'accommodation',net_amount numeric,status text default 'posted');
alter table payments add column paid_at timestamptz default now(),add column updated_at timestamptz;
create function neo_fact_currency(uuid,uuid) returns text language sql as $$select 'KES'::text$$;
create function can_read_guest_ledger() returns boolean language sql as $$select true$$;
create function neo_deposit_post(uuid,boolean) returns jsonb language sql as $$select '{"ok":true}'::jsonb$$;
create function neo_reservation_deposit_position(uuid) returns jsonb language sql as $$select '{}'::jsonb$$;
