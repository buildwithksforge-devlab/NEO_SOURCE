REVOKE ALL ON FUNCTION public.neo_delivery_consume_lines(uuid) FROM authenticated;

DO $$
DECLARE d uuid;
BEGIN
  FOR d IN SELECT id FROM public.delivery_orders
            WHERE order_number IN ('DEL-2026-000001','DEL-2026-000002')
              AND lower(COALESCE(order_status,'')) IN ('delivered','completed')
  LOOP
    PERFORM public.neo_delivery_consume_lines(d);
  END LOOP;
END $$;