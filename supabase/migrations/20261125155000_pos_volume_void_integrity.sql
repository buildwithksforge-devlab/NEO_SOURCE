-- NEØ measured beverage cancellation integrity.
-- Prevent automatic restoration of already-poured stock.
-- No historical business rows modified.

BEGIN;

DO $patch$
DECLARE
    d text;
    old_anchor text;
    new_anchor text;
BEGIN
    d := pg_get_functiondef(
        'public.neo_pos_item_void_effect()'::regprocedure
    );

    IF md5(d) <> 'cd55d43dd08c8ea30155c9e799f9a519' THEN
        RAISE EXCEPTION 'POS void function source drift';
    END IF;

    old_anchor := $old$WHERE order_item_id = NEW.id AND status = 'posted' LIMIT 1;$old$;

    new_anchor := $new$WHERE order_item_id = NEW.id
     AND organization_id = NEW.organization_id
     AND posting_type = 'consumption'
     AND status = 'posted'
   LIMIT 1;$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Consumption evidence anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    old_anchor := $old$IF v_prepared THEN$old$;

    new_anchor := $new$-- A measured pour is physical consumption.
  -- Never automatically recreate a sealed bottle after pouring.

  IF EXISTS (
      SELECT 1
      FROM public.stock_container_events ce
      WHERE ce.organization_id = NEW.organization_id
        AND ce.reference_type = 'pos_order_item'
        AND ce.reference_id = NEW.id
        AND ce.event_type = 'pour'
        AND ce.volume_delta_ml < 0
  ) THEN
      v_prepared := true;
  END IF;

  IF v_prepared THEN$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Prepared cancellation anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    old_anchor := $old$AND movement_type = 'consumption'
  LOOP$old$;

    new_anchor := $new$AND movement_type = 'consumption'
       AND NOT EXISTS (
           SELECT 1
           FROM public.stock_container_events ce
           WHERE ce.organization_id = NEW.organization_id
             AND ce.stock_movement_id = stock_movements.id
             AND ce.event_type = 'open'
       )
  LOOP$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Stock restoration anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    -- Every reversal references its original stock movement.

    old_anchor := $old$'reverse:'
        || NEW.id::text || ':' || v_mv.stock_item_id::text$old$;

    new_anchor := $new$'reverse:'
        || NEW.id::text || ':' || v_mv.id::text$new$;

    IF length(d) - length(replace(d,old_anchor,''))
       <> length(old_anchor) THEN
        RAISE EXCEPTION 'Stock reversal identity anchor changed';
    END IF;

    d := replace(d,old_anchor,new_anchor);

    EXECUTE d;
END;
$patch$;

COMMIT;