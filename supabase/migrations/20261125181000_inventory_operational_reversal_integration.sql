BEGIN;

CREATE FUNCTION pg_temp.neo_reversal_patch(
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
       OR length(_source)
          - length(replace(_source,_old,''))
          <> length(_old)
    THEN
        RAISE EXCEPTION
            'Operational reversal anchor changed: %',
            left(_old,120);
    END IF;

    RETURN replace(_source,_old,_new);
END;
$$;

-- Durable exceptions where physical restoration succeeded
-- but financial evidence validation could not complete.

CREATE TABLE public.neo_inventory_restoration_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    branch_id uuid,
    consumption_event_id uuid NOT NULL
        REFERENCES public.inventory_posting_events(id),
    original_stock_movement_id uuid NOT NULL
        REFERENCES public.stock_movements(id),
    restoration_stock_movement_id uuid NOT NULL
        REFERENCES public.stock_movements(id),
    error_message text NOT NULL,
    sqlstate text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,

    UNIQUE (
        organization_id,
        restoration_stock_movement_id
    )
);

ALTER TABLE public.neo_inventory_restoration_exceptions
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.neo_inventory_restoration_exceptions
FROM PUBLIC, anon, authenticated;

DO $patch$
DECLARE
    d text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_item_void_effect()'::regprocedure
    );

    IF position(
        'v_mv.id::text' IN d
    ) = 0 THEN
        RAISE EXCEPTION
            'Movement-specific reversal prerequisite missing';
    END IF;

    d := pg_temp.neo_reversal_patch(
        d,
        $old$v_direct boolean; v_mode text;$old$,

        $new$v_direct boolean; v_mode text;
  v_restoration_id uuid;
  v_finance_result jsonb;
  v_prior_system_posting text;
  v_error text;
  v_sqlstate text;
  v_restoration_count integer := 0;
  v_finance_failures integer := 0;$new$
    );

    -- Direct-stock products already served are not
    -- automatically recoverable.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$v_prepared := NOT COALESCE(v_direct, false)
                AND (NEW.sent_at IS NOT NULL OR NEW.ready_at IS NOT NULL OR NEW.served_at IS NOT NULL);$old$,

        $new$v_prepared :=
      NEW.served_at IS NOT NULL
      OR OLD.served_at IS NOT NULL
      OR NEW.ready_at IS NOT NULL
      OR OLD.ready_at IS NOT NULL
      OR (
          NOT COALESCE(v_direct,false)
          AND (
              NEW.sent_at IS NOT NULL
              OR OLD.sent_at IS NOT NULL
          )
      );$new$
    );

    -- Select the canonical original-sale consumption.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$AND posting_type = 'consumption'
     AND status = 'posted'
   LIMIT 1;$old$,

        $new$AND posting_type = 'consumption'
     AND idempotency_key = 'consume:' || NEW.id::text
     AND status = 'posted'
   FOR UPDATE;$new$
    );

    -- Tenant-safe order and menu context.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$FROM pos_orders WHERE id = NEW.order_id;$old$,

        $new$FROM pos_orders
   WHERE id = NEW.order_id
     AND organization_id = NEW.organization_id;$new$
    );

    d := pg_temp.neo_reversal_patch(
        d,
        $old$FROM menu_items WHERE id = NEW.menu_item_id;$old$,

        $new$FROM menu_items
   WHERE id = NEW.menu_item_id
     AND organization_id = NEW.organization_id;$new$
    );

    -- Preserve the caller's existing system-posting context.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$PERFORM set_config('neo.system_posting', '1', true);$old$,

        $new$v_prior_system_posting :=
      coalesce(current_setting('neo.system_posting',true),'');

  PERFORM set_config('neo.system_posting','1',true);$new$
    );

    -- Restrict restoration to original-sale movements.
    -- Exclude remake, wastage and opened-container movements.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$AND movement_type = 'consumption'
       AND NOT EXISTS ($old$,

        $new$AND movement_type = 'consumption'
       AND idempotency_key =
           'consume:' || NEW.id::text
           || ':' || stock_item_id::text
       AND NOT EXISTS ($new$
    );

    -- Previous historical item-based reversal keys
    -- must not produce another stock restoration.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$PERFORM inventory_apply_movement(v_mv.stock_item_id, v_mv.location_id, abs(v_mv.quantity), v_mv.unit,$old$,

        $new$IF EXISTS (
        SELECT 1
        FROM public.stock_movements historical
        WHERE historical.organization_id = NEW.organization_id
          AND historical.reference_type = 'pos_order_item'
          AND historical.reference_id = NEW.id
          AND historical.movement_type = 'reversal'
          AND historical.stock_item_id = v_mv.stock_item_id
          AND historical.location_id = v_mv.location_id
          AND historical.idempotency_key =
              'reverse:' || NEW.id::text
              || ':' || v_mv.stock_item_id::text
    ) THEN

        INSERT INTO public.audit_logs (
            organization_id,branch_id,station_id,
            user_name,action,module,record_id,
            new_value,reason
        )
        VALUES (
            NEW.organization_id,v_branch,NEW.station_id,
            COALESCE(auth.uid()::text,'system'),
            'inventory.reversal.historical-excluded',
            'inventory',NEW.id::text,
            jsonb_build_object(
                'original_movement_id',v_mv.id
            ),
            'Historical restoration identity requires reconciliation'
        );

        CONTINUE;

    END IF;

    v_restoration_id :=
      public.inventory_apply_movement(v_mv.stock_item_id, v_mv.location_id, abs(v_mv.quantity), v_mv.unit,$new$
    );

    -- Recognise financial restoration using actual movement evidence.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$v_cost := v_cost + abs(v_mv.quantity) * COALESCE(v_mv.unit_cost, 0);$old$,

        $new$IF v_restoration_id IS NULL THEN
        RAISE EXCEPTION 'Missing actual restoration movement identity';
    END IF;

    v_restoration_count := v_restoration_count + 1;

    SELECT v_cost + abs(m.value)
      INTO STRICT v_cost
      FROM public.stock_movements m
     WHERE m.id = v_restoration_id
       AND m.organization_id = NEW.organization_id
       AND m.stock_item_id = v_mv.stock_item_id
       AND m.location_id = v_mv.location_id
       AND m.reference_id = NEW.id
       AND m.movement_type = 'reversal'
       AND m.quantity > 0
       AND m.value >= 0
       AND m.value::text NOT IN (
           'NaN','Infinity','-Infinity'
       );

    BEGIN

        v_finance_result :=
            public.neo_inventory_post_restoration_finance(
                v_event.id,
                v_mv.id,
                v_restoration_id
            );

        IF v_finance_result->>'status'
           IN ('failed','unverified')
        THEN
            v_finance_failures :=
                v_finance_failures + 1;
        END IF;

    EXCEPTION WHEN OTHERS THEN

        GET STACKED DIAGNOSTICS
            v_error = MESSAGE_TEXT,
            v_sqlstate = RETURNED_SQLSTATE;

        INSERT INTO
            public.neo_inventory_restoration_exceptions (
                organization_id,
                branch_id,
                consumption_event_id,
                original_stock_movement_id,
                restoration_stock_movement_id,
                error_message,
                sqlstate
            )
        VALUES (
            NEW.organization_id,
            v_branch,
            v_event.id,
            v_mv.id,
            v_restoration_id,
            left(v_error,1000),
            v_sqlstate
        )
        ON CONFLICT (
            organization_id,
            restoration_stock_movement_id
        )
        DO UPDATE SET
            error_message = EXCLUDED.error_message,
            sqlstate = EXCLUDED.sqlstate,
            resolved_at = NULL;

        v_finance_failures :=
            v_finance_failures + 1;

    END;$new$
    );

    d := pg_temp.neo_reversal_patch(
        d,
        $old$PERFORM set_config('neo.system_posting', '', true);$old$,

        $new$PERFORM set_config(
      'neo.system_posting',
      v_prior_system_posting,
      true
  );$new$
    );

    -- Do not claim that stock was restored where no
    -- eligible original movement was found.

    d := pg_temp.neo_reversal_patch(
        d,
        $old$UPDATE inventory_posting_events SET status = 'reversed', updated_at = now()
   WHERE id = v_event.id;$old$,

        $new$IF v_restoration_count > 0
   AND NOT EXISTS (
       SELECT 1
       FROM public.stock_movements original
       WHERE original.organization_id = NEW.organization_id
         AND original.reference_type = 'pos_order_item'
         AND original.reference_id = NEW.id
         AND original.movement_type = 'consumption'
         AND original.quantity < 0
         AND NOT EXISTS (
             SELECT 1
             FROM public.stock_movements restored
             WHERE restored.organization_id =
                   original.organization_id
               AND restored.reference_type =
                   original.reference_type
               AND restored.reference_id =
                   original.reference_id
               AND restored.stock_item_id =
                   original.stock_item_id
               AND restored.location_id =
                   original.location_id
               AND restored.movement_type = 'reversal'
               AND restored.idempotency_key =
                   'reverse:' || NEW.id::text ||
                   ':' || original.id::text
               AND restored.quantity =
                   abs(original.quantity)
         )
   )
THEN

      UPDATE public.inventory_posting_events
         SET status = 'reversed',
             updated_at = now()
       WHERE id = v_event.id
         AND organization_id = NEW.organization_id;

  END IF;$new$
    );

    d := pg_temp.neo_reversal_patch(
        d,
        $old$jsonb_build_object('reversed_value', v_cost, 'item', NEW.item_name, 'consumption_mode', v_mode),$old$,

        $new$jsonb_build_object(
        'reversed_value',v_cost,
        'item',NEW.item_name,
        'consumption_mode',v_mode,
        'restoration_count',v_restoration_count,
        'financial_exceptions',v_finance_failures
    ),$new$
    );

    EXECUTE d;

END;
$patch$;

COMMIT;