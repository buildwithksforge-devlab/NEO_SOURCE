BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_inventory_reversed_recovery_eligible(
    _event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    e public.inventory_posting_events;

    r public.neo_inventory_finance_reversals;

    evidence jsonb;

    original_value numeric;

    original_count integer;

BEGIN

    IF auth.uid() IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'finance','approve'
           ) IS TRUE
       )
    THEN
        RETURN false;
    END IF;

    SELECT *
    INTO e

    FROM public.inventory_posting_events

    WHERE id = _event_id
      AND organization_id = public.current_org_id()

    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF public.neo_branch_in_scope(
        e.branch_id
    ) IS NOT TRUE THEN
        RETURN false;
    END IF;

    IF e.order_item_id IS NULL
       OR e.posting_type IS DISTINCT FROM 'consumption'
       OR e.status IS DISTINCT FROM 'reversed'
       OR e.finance_journal_id IS NOT NULL
       OR e.finance_posting_status IS NULL
       OR e.finance_posting_status IN (
           'posted','zero-value','reversed'
       )
       OR e.payload->>'valuation_status'
          IS DISTINCT FROM 'verified'
       OR e.cost_snapshot IS NULL
       OR e.cost_snapshot < 0
       OR e.cost_snapshot::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RETURN false;
    END IF;

    IF (
        SELECT count(*)
        FROM public.inventory_posting_events x
        WHERE x.organization_id = e.organization_id
          AND x.order_item_id = e.order_item_id
          AND x.posting_type = 'consumption'
    ) <> 1 THEN
        RETURN false;
    END IF;

    SELECT
        count(*)::integer,
        coalesce(sum(abs(m.value)),0)

    INTO
        original_count,
        original_value

    FROM public.stock_movements m

    WHERE m.organization_id = e.organization_id
      AND m.reference_type = 'pos_order_item'
      AND m.reference_id = e.order_item_id
      AND m.movement_type = 'consumption';

    IF original_count = 0
       OR original_value IS DISTINCT FROM e.cost_snapshot
    THEN
        RETURN false;
    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.stock_movements m

        WHERE m.organization_id = e.organization_id
          AND m.reference_type = 'pos_order_item'
          AND m.reference_id = e.order_item_id
          AND m.movement_type = 'consumption'

          AND (

              m.quantity IS NULL
              OR m.quantity >= 0
              OR m.value IS NULL
              OR m.value > 0

              OR m.quantity::text IN (
                  'NaN','Infinity','-Infinity'
              )

              OR m.value::text IN (
                  'NaN','Infinity','-Infinity'
              )

              OR (

                  SELECT coalesce(
                      sum(x.restored_quantity),0
                  )

                  FROM public.neo_inventory_finance_reversals x

                  WHERE x.organization_id = e.organization_id
                    AND x.consumption_event_id = e.id
                    AND x.original_stock_movement_id = m.id

              ) IS DISTINCT FROM abs(m.quantity)

              OR (

                  SELECT coalesce(
                      sum(x.restored_value),0
                  )

                  FROM public.neo_inventory_finance_reversals x

                  WHERE x.organization_id = e.organization_id
                    AND x.consumption_event_id = e.id
                    AND x.original_stock_movement_id = m.id

              ) IS DISTINCT FROM abs(m.value)

          )

    ) THEN
        RETURN false;
    END IF;

    FOR r IN

        SELECT *
        FROM public.neo_inventory_finance_reversals

        WHERE organization_id = e.organization_id
          AND consumption_event_id = e.id

        ORDER BY id

        FOR UPDATE

    LOOP

        IF r.branch_id IS DISTINCT FROM e.branch_id

           OR r.status IS NULL

           OR r.status IN (
               'posted','zero-value','legacy-excluded'
           )

           OR r.reversal_journal_id IS NOT NULL

        THEN
            RETURN false;
        END IF;

        evidence :=
            public.neo_inventory_validate_restoration(

                e.id,

                r.original_stock_movement_id,

                r.restoration_stock_movement_id

            );

        IF evidence->>'status'
              IS DISTINCT FROM 'validated'

           OR (evidence->>'restored_quantity')::numeric
              IS DISTINCT FROM r.restored_quantity

           OR (evidence->>'restored_value')::numeric
              IS DISTINCT FROM r.restored_value

        THEN
            RETURN false;
        END IF;

    END LOOP;

    RETURN true;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_reversed_recovery_eligible(uuid)
FROM PUBLIC,anon,authenticated;

-- Extend the canonical consumption finance engine.
-- Physical event status is never rewritten.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'OR e.status <> ''posted''';

BEGIN

    d := pg_get_functiondef(
        'public.neo_inventory_post_consumption_finance(uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Consumption engine baseline differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

       OR (

           e.status <> 'posted'

           AND NOT (

               e.status = 'reversed'

               AND public.neo_inventory_reversed_recovery_eligible(
                   e.id
               ) IS TRUE

           )

       )

$patch$

    );

    EXECUTE d;

END;
$migration$;

CREATE OR REPLACE FUNCTION
public.neo_inventory_recover_reversed_accounting(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE

    e public.inventory_posting_events;

    r public.neo_inventory_finance_reversals;

    original_result jsonb;

    result jsonb;

    results jsonb := '[]'::jsonb;

    restored_count integer := 0;

BEGIN

    IF public.neo_inventory_reversed_recovery_eligible(
        _event_id
    ) IS NOT TRUE THEN

        RAISE EXCEPTION
            'Consumption recovery evidence is incomplete or unauthorized';

    END IF;

    SELECT *
    INTO e

    FROM public.inventory_posting_events

    WHERE id = _event_id
      AND organization_id = public.current_org_id()

    FOR UPDATE;

    original_result :=
        public.neo_inventory_post_consumption_finance(
            e.id
        );

    IF coalesce(
        original_result->>'status',''
    ) NOT IN (
        'posted','zero-value'
    ) THEN

        RAISE EXCEPTION
            'Original COGS recognition failed';

    END IF;

    FOR r IN

        SELECT *
        FROM public.neo_inventory_finance_reversals

        WHERE organization_id = e.organization_id
          AND branch_id IS NOT DISTINCT FROM e.branch_id
          AND consumption_event_id = e.id

        ORDER BY id

    LOOP

        result :=
            public.neo_inventory_post_restoration_finance(

                e.id,

                r.original_stock_movement_id,

                r.restoration_stock_movement_id

            );

        IF coalesce(
            result->>'status',''
        ) NOT IN (
            'posted','zero-value'
        ) THEN

            RAISE EXCEPTION
                'Compensating accounting recognition failed';

        END IF;

        results := results ||
            jsonb_build_array(result);

        restored_count := restored_count + 1;

    END LOOP;

    IF restored_count = 0 THEN

        RAISE EXCEPTION
            'Restoration accounting evidence is missing';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.neo_inventory_finance_reversals x

        WHERE x.organization_id = e.organization_id
          AND x.consumption_event_id = e.id

          AND coalesce(x.status,'') NOT IN (
              'posted','zero-value'
          )

    ) THEN

        RAISE EXCEPTION
            'Restoration accounting remains incomplete';

    END IF;

    IF (

        SELECT coalesce(
            sum(x.reversed_amount),0
        )

        FROM public.neo_inventory_finance_reversals x

        WHERE x.organization_id = e.organization_id
          AND x.consumption_event_id = e.id

    ) IS DISTINCT FROM round(e.cost_snapshot,2)

    THEN

        RAISE EXCEPTION
            'Recovered COGS and compensating values do not reconcile';

    END IF;

    RETURN jsonb_build_object(

        'status','recovered',

        'event_id',e.id,

        'original',original_result,

        'restorations_reconciled',restored_count,

        'restoration_results',results,

        'physical_stock_unchanged',true

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_recover_reversed_accounting(uuid)
FROM PUBLIC,anon,authenticated;

-- Reuse the existing authorized inventory recovery RPC.

DO $migration$
DECLARE

    d text;

    anchor text :=
        'RETURN jsonb_build_object(
            ''status'',''coordinated-recovery-required'',';

BEGIN

    d := pg_get_functiondef(
        'public.neo_retry_inventory_consumption_finance(uuid)'
        ::regprocedure
    );

    IF position(anchor IN d) = 0 THEN

        RAISE EXCEPTION
            'Canonical recovery entry point differs';

    END IF;

    d := replace(

        d,

        anchor,

$patch$

        IF public.neo_inventory_reversed_recovery_eligible(
            e.id
        ) IS TRUE THEN

            RETURN
                public.neo_inventory_recover_reversed_accounting(
                    e.id
                );

        END IF;

$patch$

        || anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;

-- NEO_CORE_INVENTORY_EXECUTION_V1

DO $core_inventory$
DECLARE
    d text;
    signature regprocedure;
    anchor text;
BEGIN

    signature := to_regprocedure(
        'public.inventory_order_consumption_trigger()'
    );

    IF signature IS NULL THEN
        RAISE EXCEPTION 'Order consumption trigger missing';
    END IF;

    d := pg_get_functiondef(signature);

    anchor := 'COALESCE(status,'''') <> ''voided''';

    IF strpos(d,anchor)>0 THEN

        d := replace(
            d,
            anchor,
            'COALESCE(status,'''') NOT IN (''voided'',''cancelled'',''draft'',''cancel-pending'')'
        );

        EXECUTE d;

    ELSIF strpos(
        d,
        'COALESCE(status,'''') NOT IN (''voided'',''cancelled'',''draft'',''cancel-pending'')'
    )=0 THEN

        RAISE EXCEPTION 'Order consumption lifecycle filter differs';

    END IF;

END;
$core_inventory$;


DO $inventory_context$
DECLARE
    d text;
    signature regprocedure;
BEGIN

    signature := to_regprocedure(
        'public.inventory_consume_order_item(uuid)'
    );

    IF signature IS NULL THEN
        RAISE EXCEPTION 'Canonical inventory wrapper missing';
    END IF;

    d := pg_get_functiondef(signature);

    IF strpos(d,'neo_preserve_inventory_context_v1')=0 THEN

        IF strpos(d,'DECLARE v_result jsonb;')=0
           OR strpos(d,'PERFORM set_config(''neo.system_posting'', ''0'', true);')=0
        THEN
            RAISE EXCEPTION 'Inventory execution context anchor differs';
        END IF;

        d := replace(
            d,
            'DECLARE v_result jsonb;',
            $patch$
DECLARE
  v_result jsonb;
  v_prior_posting text :=
    coalesce(current_setting('neo.system_posting',true),'');
  -- neo_preserve_inventory_context_v1
$patch$
        );

        d := replace(
            d,
            'PERFORM set_config(''neo.system_posting'', ''0'', true);',
            'PERFORM set_config(''neo.system_posting'', v_prior_posting, true);'
        );

        EXECUTE d;

    END IF;

END;
$inventory_context$;

-- NEO_PRODUCTION_MEASUREMENT_INTEGRITY_V1
-- Preserve the existing operational batch inventory policy.
-- No historical stock movements or recipe data are modified.

DO $production_measurement$
DECLARE
    d text;
    signature regprocedure;
    anchor text;
BEGIN
    signature := to_regprocedure(
        'public.neo_production_batch_post(uuid,uuid)'
    );

    IF signature IS NULL THEN
        RAISE EXCEPTION 'Canonical production posting function missing';
    END IF;

    d := pg_get_functiondef(signature);

    IF strpos(d,'neo_production_measurement_integrity_v1')=0 THEN

        anchor :=
            '  SELECT *'
            || chr(10)
            || '    INTO v_recipe';

        IF strpos(d,anchor)=0 THEN
            RAISE EXCEPTION 'Production recipe selection anchor differs';
        END IF;

        d := replace(
            d,
            anchor,
            $patch$
  -- neo_production_measurement_integrity_v1

  IF v_b.planned_quantity IS NULL
     OR v_b.planned_quantity <= 0
     OR v_b.planned_quantity::text IN (
       'NaN','Infinity','-Infinity'
     )
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_planned_quantity'
    );
  END IF;

  IF v_b.status IN ('discarded','closed','fully-used') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_batch_status'
    );
  END IF;

  IF v_b.use_by IS NOT NULL AND v_b.use_by < now() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','expired_batch'
    );
  END IF;

  IF v_b.prepared_at IS NOT NULL
     AND v_b.use_by IS NOT NULL
     AND v_b.use_by <= v_b.prepared_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_production_dates'
    );
  END IF;

  IF v_b.actual_quantity - coalesce(v_b.waste_quantity,0) <= 0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','no_usable_output'
    );
  END IF;

$patch$ || anchor
        );

        anchor := '         remaining_quantity = v_available,';

        IF strpos(d,anchor)=0 THEN
            RAISE EXCEPTION 'Production output update anchor differs';
        END IF;

        d := replace(
            d,
            anchor,
            anchor || chr(10) ||
            '         yield_variance = v_available - v_b.planned_quantity,'
        );

        EXECUTE d;

    END IF;
END;
$production_measurement$;


-- Protect finalized production measurements without preventing
-- the canonical allocation engine from updating remaining stock.

CREATE OR REPLACE FUNCTION public.neo_production_measurement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public,pg_temp
AS $function$
BEGIN

    IF OLD.posted_at IS NULL THEN

        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;

        RETURN NEW;

    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'Posted production history cannot be deleted'
          USING ERRCODE='23514';
    END IF;

    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.station_id IS DISTINCT FROM OLD.station_id
       OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id
       OR NEW.batch_number IS DISTINCT FROM OLD.batch_number
       OR NEW.planned_quantity IS DISTINCT FROM OLD.planned_quantity
       OR NEW.actual_quantity IS DISTINCT FROM OLD.actual_quantity
       OR NEW.waste_quantity IS DISTINCT FROM OLD.waste_quantity
       OR NEW.unit IS DISTINCT FROM OLD.unit
       OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
       OR NEW.use_by IS DISTINCT FROM OLD.use_by
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.output_location_id IS DISTINCT FROM OLD.output_location_id
       OR NEW.yield_variance IS DISTINCT FROM OLD.yield_variance
       OR NEW.posted_cost IS DISTINCT FROM OLD.posted_cost
    THEN
        RAISE EXCEPTION
          'Posted production measurements are immutable'
          USING ERRCODE='23514';
    END IF;

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
 public.neo_production_measurement_immutable()
 FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
 neo_production_measurement_immutable
 ON public.production_batches;

CREATE TRIGGER neo_production_measurement_immutable
BEFORE UPDATE OR DELETE ON public.production_batches
FOR EACH ROW EXECUTE FUNCTION
 public.neo_production_measurement_immutable();

-- NEO_BATCH_RECIPE_CONFIGURATION_V1
-- Keep explicit operational batch configuration when approving
-- a replacement standard recipe.

DO $batch_recipe_configuration$
DECLARE
    d text;
    anchor text;
    replacement text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_recipe_activate(uuid,uuid)'::regprocedure
    );

    IF strpos(d,'neo_batch_recipe_configuration_v1')>0 THEN
        RETURN;
    END IF;

    anchor :=
      'consumption_mode=CASE WHEN r.recipe_type=''direct_sale'' THEN ''direct_stock'' ELSE ''recipe'' END';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION 'Canonical recipe activation anchor differs';
    END IF;

    replacement := $patch$
consumption_mode=CASE
        WHEN r.recipe_type='direct_sale'
          THEN 'direct_stock'
        WHEN consumption_mode='batch'
          THEN 'batch'
        ELSE 'recipe'
      END
$patch$;

    d := replace(d,anchor,replacement);

    d := replace(
      d,
      'UPDATE public.menu_items SET',
      '-- neo_batch_recipe_configuration_v1'
        || chr(10)
        || '    UPDATE public.menu_items SET'
    );

    EXECUTE d;

END;
$batch_recipe_configuration$;


-- NEO_PRODUCTION_RECIPE_UNIT_GUARD_V1

DO $production_recipe_unit$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_production_batch_post(uuid,uuid)'
        ::regprocedure
    );

    anchor := '  v_available :=';

    IF strpos(d,anchor)=0 THEN
        RAISE EXCEPTION
          'Canonical production quantity anchor differs';
    END IF;

    IF strpos(d,'neo_production_recipe_unit_guard_v1')>0 THEN
        RETURN;
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
  -- neo_production_recipe_unit_guard_v1

  IF v_recipe.status IS DISTINCT FROM 'active'
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','inactive_recipe'
    );
  END IF;

  IF v_recipe.yield_quantity IS NULL
     OR v_recipe.yield_quantity <= 0
     OR v_recipe.yield_quantity::text IN (
       'NaN','Infinity','-Infinity'
     )
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bad_yield'
    );
  END IF;

  IF nullif(btrim(coalesce(v_recipe.yield_unit,'')),'') IS NULL
     OR nullif(btrim(coalesce(v_b.unit,'')),'') IS NULL
     OR lower(btrim(v_b.unit))
        IS DISTINCT FROM
        lower(btrim(v_recipe.yield_unit))
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','recipe_unit_mismatch'
    );
  END IF;

  IF v_recipe.station_id IS NOT NULL
     AND v_b.station_id IS DISTINCT FROM v_recipe.station_id
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','recipe_station_mismatch'
    );
  END IF;

  IF v_b.status IS NULL
     OR v_b.status NOT IN ('planned','in-preparation','completed')
  THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','invalid_batch_status'
    );
  END IF;

$patch$ || anchor
    );

    EXECUTE d;

END;
$production_recipe_unit$;
