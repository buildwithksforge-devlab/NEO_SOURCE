-- Workspace-aware keys on the parent records.
alter table public.rooms add constraint rooms_org_id_key unique (organization_id, id);
alter table public.room_types add constraint room_types_org_id_key unique (organization_id, id);
alter table public.rate_plans add constraint rate_plans_org_id_key unique (organization_id, id);
alter table public.customers add constraint customers_org_id_key unique (organization_id, id);
alter table public.folios add constraint folios_org_id_key unique (organization_id, id);
alter table public.reservations add constraint reservations_org_id_key unique (organization_id, id);
alter table public.pos_orders add constraint pos_orders_org_id_key unique (organization_id, id);
alter table public.menu_items add constraint menu_items_org_id_key unique (organization_id, id);
alter table public.suppliers add constraint suppliers_org_id_key unique (organization_id, id);
alter table public.purchase_requests add constraint purchase_requests_org_id_key unique (organization_id, id);
alter table public.stock_items add constraint stock_items_org_id_key unique (organization_id, id);
alter table public.departments add constraint departments_org_id_key unique (organization_id, id);
alter table public.asset_categories add constraint asset_categories_org_id_key unique (organization_id, id);

-- Tenant-safe relationships.
alter table public.reservations
  add constraint reservations_room_tenant_fkey foreign key (organization_id, room_id)
    references public.rooms (organization_id, id),
  add constraint reservations_room_type_tenant_fkey foreign key (organization_id, room_type_id)
    references public.room_types (organization_id, id),
  add constraint reservations_rate_plan_tenant_fkey foreign key (organization_id, rate_plan_id)
    references public.rate_plans (organization_id, id),
  add constraint reservations_customer_tenant_fkey foreign key (organization_id, customer_id)
    references public.customers (organization_id, id);

alter table public.folio_lines
  add constraint folio_lines_folio_tenant_fkey foreign key (organization_id, folio_id)
    references public.folios (organization_id, id) on delete cascade,
  add constraint folio_lines_reservation_tenant_fkey foreign key (organization_id, reservation_id)
    references public.reservations (organization_id, id);

alter table public.pos_order_items
  add constraint pos_order_items_order_tenant_fkey foreign key (organization_id, order_id)
    references public.pos_orders (organization_id, id) on delete cascade,
  add constraint pos_order_items_menu_item_tenant_fkey foreign key (organization_id, menu_item_id)
    references public.menu_items (organization_id, id);

alter table public.purchase_orders
  add constraint purchase_orders_supplier_tenant_fkey foreign key (organization_id, supplier_id)
    references public.suppliers (organization_id, id) on delete restrict,
  add constraint purchase_orders_request_tenant_fkey foreign key (organization_id, request_id)
    references public.purchase_requests (organization_id, id);

alter table public.stock_movements
  add constraint stock_movements_item_tenant_fkey foreign key (organization_id, stock_item_id)
    references public.stock_items (organization_id, id) on delete cascade;

alter table public.assets
  add constraint assets_department_tenant_fkey foreign key (organization_id, department_id)
    references public.departments (organization_id, id),
  add constraint assets_category_tenant_fkey foreign key (organization_id, category_id)
    references public.asset_categories (organization_id, id);