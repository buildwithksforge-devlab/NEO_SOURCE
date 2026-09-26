DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT oi.id, oi.status
      FROM public.delivery_orders d
      JOIN public.pos_order_items oi ON oi.order_id = d.pos_order_id
     WHERE d.order_number IN ('DEL-2026-000001','DEL-2026-000002')
       AND oi.status IN ('sent','accepted','preparing','ready')
  LOOP
    IF r.status <> 'ready' THEN
      UPDATE public.pos_order_items SET status='ready' WHERE id = r.id;
    END IF;
    UPDATE public.pos_order_items SET status='served' WHERE id = r.id;
  END LOOP;
END $$;