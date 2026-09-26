DO $do$
DECLARE
  v_def text;
  v_extra text := $x$
  UNION ALL
  SELECT * FROM (
    SELECT 'sold_item_without_recipe'::text, 'warning'::text, 'Menu item'::text,
           ('Sold ' || count(*)::text || ' time(s) in this period but has no active recipe and no direct stock item, so no inventory can be consumed.')::text,
           i.menu_item_id AS record_id,
           min(i.item_name)::text,
           min(i.created_at) AS occurred_at
      FROM public.pos_order_items i
      JOIN public.pos_orders o ON o.id = i.order_id
      JOIN public.menu_items mi ON mi.id = i.menu_item_id
     WHERE o.organization_id = v_org
       AND (_branch IS NULL OR o.branch_id = _branch)
       AND o.created_at BETWEEN _from AND _to
       AND o.status NOT IN ('draft','cancelled','voided')
       AND mi.stock_item_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.recipes r
          WHERE r.menu_item_id = i.menu_item_id
            AND r.organization_id = o.organization_id
            AND COALESCE(r.status,'active') NOT IN ('archived','draft','inactive'))
     GROUP BY i.menu_item_id
  ) norecipe

  UNION ALL
  SELECT 'delivery_without_invoice', 'error', 'Delivery order',
         'Delivered and paid, but no invoice was raised, so the items and delivery fee never reached revenue.',
         d.id, d.order_number, d.created_at
    FROM public.delivery_orders d
   WHERE d.organization_id = v_org
     AND (_branch IS NULL OR d.branch_id = _branch)
     AND d.created_at BETWEEN _from AND _to
     AND d.order_status NOT IN ('cancelled','rejected','failed')
     AND lower(COALESCE(d.payment_status,'')) IN ('paid','settled','captured','completed')
     AND NOT EXISTS (
       SELECT 1 FROM public.invoices inv
        WHERE inv.organization_id = d.organization_id
          AND inv.notes LIKE '%delivery-order:' || d.id::text || '%')

  ORDER BY 2, 1, 7 DESC;$x$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_commerce_reconciliation';

  IF position('sold_item_without_recipe' in v_def) > 0 THEN
    RETURN;
  END IF;

  v_def := replace(v_def, '  ORDER BY 2, 1, 7 DESC;', v_extra);
  EXECUTE v_def;
END
$do$;