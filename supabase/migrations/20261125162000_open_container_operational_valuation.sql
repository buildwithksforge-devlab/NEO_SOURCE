-- NEØ operational open-container monetary valuation.
-- Preserve historical pool costs and serialize container operations.
-- Existing historical records are not backfilled.

BEGIN;

CREATE FUNCTION pg_temp.neo_container_patch(
    _source text,
    _old text,
    _new text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
    IF _source IS NULL
       OR length(_old) = 0
       OR length(_source) - length(replace(_source,_old,''))
          <> length(_old)
    THEN
        RAISE EXCEPTION 'Container source anchor changed: %',
            left(_old,100);
    END IF;

    RETURN replace(_source,_old,_new);
END;
$$;

DO $patch$
DECLARE
    d text;
    v_guard text;
BEGIN

    -- Common permission, tenant and concurrency boundary.
    -- Use the same operational permission model as stock movements.

    v_guard := $guard$
  IF public.neo_system_posting() IS NOT TRUE
     AND (
         public.has_permission('inventory','stock.manage')
         OR public.has_permission('procurement','receiving.manage')
     ) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Not permitted to move stock'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
      SELECT 1
      FROM public.stock_locations sl
      WHERE sl.id = _location
        AND sl.organization_id = v_org
        AND public.neo_branch_in_scope(sl.branch_id) IS TRUE
  ) THEN
      RAISE EXCEPTION 'Stock location outside authorised scope'
        USING ERRCODE = '42501';
  END IF;

  IF _idempotency_key IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
          hashtextextended(
              'neo-container-event:' || v_org::text
              || ':' || _idempotency_key,
              0
          )
      );
  END IF;

  PERFORM pg_advisory_xact_lock(
      hashtextextended(
          'neo-container-pool:' || v_org::text
          || ':' || _item::text
          || ':' || _location::text,
          0
      )
  );
$guard$;

    -- =====================================================
    -- OPEN CONTAINER
    -- =====================================================

    d := pg_get_functiondef(
        'public.inventory_open_container(uuid,uuid,text,text,uuid,text)'
        ::regprocedure
    );

    IF md5(d) <> '7267e558b69b2da977af111622300185' THEN
        RAISE EXCEPTION 'Open container source drift';
    END IF;

    d := pg_temp.neo_container_patch(
        d,
        $old$v_move uuid; v_existing record;$old$,
        $new$v_move uuid; v_existing record;
  v_open_value numeric;$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;$old$,
        $new$IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;$new$
        || v_guard
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$RETURN jsonb_build_object('status','already-recorded','event_id',v_existing.id);$old$,
        $new$IF v_existing.event_type IS DISTINCT FROM 'open'
         OR v_existing.stock_item_id IS DISTINCT FROM _item
         OR v_existing.location_id IS DISTINCT FROM _location
         OR v_existing.reference_id IS DISTINCT FROM _reference_id
         OR v_existing.reference_type IS DISTINCT FROM _reference_type
      THEN
          RAISE EXCEPTION 'Container opening identity conflict'
            USING ERRCODE = '23514';
      END IF;

      RETURN jsonb_build_object(
          'status','already-recorded',
          'event_id',v_existing.id,
          'opened_value',v_existing.inventory_value_delta
      );$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$INSERT INTO stock_open_containers (organization_id, branch_id, stock_item_id, location_id)$old$,
        $new$SELECT abs(m.value)
    INTO STRICT v_open_value
    FROM public.stock_movements m
   WHERE m.id = v_move
     AND m.organization_id = v_org
     AND m.stock_item_id = _item
     AND m.location_id = _location
     AND m.movement_type = 'consumption'
     AND m.quantity = -1;

  IF v_open_value IS NULL
     OR v_open_value::text IN ('NaN','Infinity','-Infinity')
  THEN
      RAISE EXCEPTION 'Invalid container opening value'
        USING ERRCODE = '23514';
  END IF;

  INSERT INTO stock_open_containers (organization_id, branch_id, stock_item_id, location_id)$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$SET open_volume_ml = open_volume_ml + v_item.container_volume_ml,$old$,
        $new$SET open_inventory_value =
           CASE
               WHEN open_volume_ml = 0 THEN v_open_value
               WHEN valuation_volume_ml = open_volume_ml
                 AND open_inventory_value IS NOT NULL
               THEN open_inventory_value + v_open_value
               ELSE NULL
           END,
         valuation_volume_ml =
           CASE
               WHEN open_volume_ml = 0
                 OR (
                     valuation_volume_ml = open_volume_ml
                     AND open_inventory_value IS NOT NULL
                 )
               THEN open_volume_ml + v_item.container_volume_ml
               ELSE NULL
           END,
         open_volume_ml = open_volume_ml + v_item.container_volume_ml,$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$stock_movement_id, idempotency_key, performed_by)$old$,
        $new$stock_movement_id, idempotency_key, performed_by,
    inventory_value_delta, open_inventory_value_after)$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$_reference_type, _reference_id, v_move, _idempotency_key, auth.uid());$old$,
        $new$_reference_type, _reference_id, v_move, _idempotency_key, auth.uid(),
    v_open_value, v_row.open_inventory_value);$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$'movement_id', v_move);$old$,
        $new$'movement_id', v_move,
                            'opened_value',v_open_value,
                            'open_inventory_value',v_row.open_inventory_value);$new$
    );

    EXECUTE d;

    -- =====================================================
    -- CONSUME VOLUME
    -- =====================================================

    d := pg_get_functiondef(
        'public.inventory_consume_volume(uuid,uuid,numeric,text,text,text,uuid,text)'
        ::regprocedure
    );

    IF md5(d) <> 'daccb09819e72b9826b5c56efb6b9b6a' THEN
        RAISE EXCEPTION 'Consume volume source drift';
    END IF;

    d := pg_temp.neo_container_patch(
        d,
        $old$v_guard integer := 0;$old$,
        $new$v_guard integer := 0;
  v_allocation jsonb;
  v_consumed_value numeric;$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;$old$,
        $new$IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;$new$
        || v_guard
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$IF COALESCE(_ml,0) <= 0 THEN$old$,
        $new$IF COALESCE(_ml,0) <= 0
     OR _ml::text IN ('NaN','Infinity','-Infinity') THEN$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$RETURN jsonb_build_object('status','already-recorded','event_id',v_existing.id);$old$,
        $new$IF v_existing.event_type IS DISTINCT FROM 'pour'
         OR v_existing.stock_item_id IS DISTINCT FROM _item
         OR v_existing.location_id IS DISTINCT FROM _location
         OR v_existing.reference_id IS DISTINCT FROM _reference_id
         OR v_existing.reference_type IS DISTINCT FROM _reference_type
         OR v_existing.volume_delta_ml IS DISTINCT FROM -_ml
         OR v_existing.reason_code IS DISTINCT FROM COALESCE(_reason_code,'pour')
      THEN
          RAISE EXCEPTION 'Container consumption identity conflict'
            USING ERRCODE = '23514';
      END IF;

      RETURN jsonb_build_object(
          'status','already-recorded',
          'event_id',v_existing.id,
          'consumed_value',-v_existing.inventory_value_delta
      );$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$UPDATE stock_open_containers
     SET open_volume_ml = open_volume_ml - v_needed,$old$,
        $new$v_allocation :=
    public.neo_open_container_value_allocation(
        v_row.open_volume_ml,
        CASE
            WHEN v_row.valuation_volume_ml = v_row.open_volume_ml
            THEN v_row.open_inventory_value
            ELSE NULL
        END,
        v_needed
    );

  v_consumed_value :=
      (v_allocation->>'consumed_value')::numeric;

  UPDATE stock_open_containers
     SET open_inventory_value =
             (v_allocation->>'remaining_value')::numeric,
         valuation_volume_ml =
             CASE
                 WHEN (v_allocation->>'remaining_value') IS NOT NULL
                 THEN (v_allocation->>'remaining_ml')::numeric
                 ELSE NULL
             END,
         open_volume_ml = open_volume_ml - v_needed,$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$reference_type, reference_id, idempotency_key, performed_by)$old$,
        $new$reference_type, reference_id, idempotency_key, performed_by,
    inventory_value_delta, open_inventory_value_after)$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$_reference_type, _reference_id, _idempotency_key, auth.uid());$old$,
        $new$_reference_type, _reference_id, _idempotency_key, auth.uid(),
    -v_consumed_value, v_row.open_inventory_value);$new$
    );

    d := pg_temp.neo_container_patch(
        d,
        $old$'open_volume_ml', v_row.open_volume_ml);$old$,
        $new$'open_volume_ml', v_row.open_volume_ml,
                            'consumed_value',v_consumed_value,
                            'valuation_status',v_allocation->>'valuation_status',
                            'open_inventory_value',v_row.open_inventory_value);$new$
    );

    EXECUTE d;

END;
$patch$;

COMMIT;