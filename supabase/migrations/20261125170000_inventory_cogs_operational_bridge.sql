-- NEØ operational inventory-to-finance bridge.
-- Connect newly created consumption events to COGS posting.
-- Existing historical events remain excluded.

BEGIN;

CREATE FUNCTION pg_temp.neo_inventory_bridge_patch(
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
            'Inventory finance bridge anchor changed: %',
            left(_old,100);
    END IF;

    RETURN replace(_source,_old,_new);
END;
$$;

DO $patch$
DECLARE
    d text;
BEGIN

    d := pg_get_functiondef(
        'public.inventory_consume_order_item_core(uuid)'
        ::regprocedure
    );

    IF position(
        'actual-movement-and-container-value' IN d
    ) = 0 THEN
        RAISE EXCEPTION
            'Actual consumption valuation prerequisite missing';
    END IF;

    IF to_regprocedure(
        'public.neo_inventory_post_consumption_finance(uuid)'
    ) IS NULL THEN
        RAISE EXCEPTION
            'Inventory financial engine prerequisite missing';
    END IF;

    d := pg_temp.neo_inventory_bridge_patch(
        d,
        $old$v_unverified_volume_lines integer := 0;$old$,
        $new$v_unverified_volume_lines integer := 0;
  v_finance_event_id uuid;
  v_finance_result jsonb;
  v_finance_error text;
  v_finance_sqlstate text;$new$
    );

    d := pg_temp.neo_inventory_bridge_patch(
        d,
        $old$cost_snapshot,
    payload
  )$old$,

        $new$cost_snapshot,
    payload,
    finance_posting_status
  )$new$
    );

    d := pg_temp.neo_inventory_bridge_patch(
        d,
        $old$'station_name', v_station_name
    )
  )
  ON CONFLICT DO NOTHING;$old$,

        $new$'station_name', v_station_name
    ),
    'pending'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_finance_event_id;

  -- Only newly inserted events enter this financial pathway.
  -- Do not automatically backfill historical events.

  IF v_finance_event_id IS NOT NULL THEN

      BEGIN

          v_finance_result :=
              public.neo_inventory_post_consumption_finance(
                  v_finance_event_id
              );

      EXCEPTION WHEN OTHERS THEN

          GET STACKED DIAGNOSTICS
              v_finance_error = MESSAGE_TEXT,
              v_finance_sqlstate = RETURNED_SQLSTATE;

          UPDATE public.inventory_posting_events
             SET finance_posting_status = 'failed',
                 finance_posting_error = left(
                     v_finance_sqlstate
                     || ': '
                     || v_finance_error,
                     1000
                 ),
                 finance_attempt_count =
                     finance_attempt_count + 1
           WHERE id = v_finance_event_id
             AND organization_id = v_org
             AND finance_posting_status = 'pending';

          v_finance_result := jsonb_build_object(
              'status','failed',
              'event_id',v_finance_event_id,
              'sqlstate',v_finance_sqlstate
          );

      END;

  END IF;$new$
    );

    d := pg_temp.neo_inventory_bridge_patch(
        d,
        $old$'unverified_volume_lines',v_unverified_volume_lines,
    'consumption_mode',v_mode,$old$,

        $new$'unverified_volume_lines',v_unverified_volume_lines,
    'finance_posting',v_finance_result,
    'finance_event_id',v_finance_event_id,
    'consumption_mode',v_mode,$new$
    );

    EXECUTE d;

END;
$patch$;

COMMIT;