alter table public.reservations
  drop constraint if exists reservations_room_id_fkey,
  drop constraint if exists reservations_room_type_id_fkey,
  drop constraint if exists reservations_rate_plan_id_fkey,
  drop constraint if exists reservations_customer_id_fkey;

alter table public.folio_lines
  drop constraint if exists folio_lines_folio_id_fkey,
  drop constraint if exists folio_lines_reservation_id_fkey;

alter table public.pos_order_items
  drop constraint if exists pos_order_items_order_id_fkey,
  drop constraint if exists pos_order_items_menu_item_id_fkey;

alter table public.purchase_orders
  drop constraint if exists purchase_orders_supplier_id_fkey,
  drop constraint if exists purchase_orders_request_id_fkey;

alter table public.stock_movements
  drop constraint if exists stock_movements_stock_item_id_fkey;

alter table public.assets
  drop constraint if exists assets_department_id_fkey,
  drop constraint if exists assets_category_id_fkey;