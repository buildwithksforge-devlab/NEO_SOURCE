BEGIN;

-- ============================================================
-- AUTHORITATIVE PRODUCTION PREPARATION EVIDENCE
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_pos_item_preparation_started(
    _org uuid,
    _order uuid,
    _item uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN

    IF EXISTS (

        SELECT 1

        FROM public.station_ticket_items ti

        JOIN public.station_tickets t
          ON t.id = ti.ticket_id
         AND t.organization_id = _org

        WHERE ti.organization_id = _org

          AND ti.order_item_id = _item

          AND t.order_id = _order

          AND (

              ti.status IN (
                  'preparing',
                  'ready',
                  'collected',
                  'served',
                  'completed'
              )

              OR nullif(
                  to_jsonb(ti)->>'preparing_at',''
              ) IS NOT NULL

              OR nullif(
                  to_jsonb(ti)->>'started_at',''
              ) IS NOT NULL

              OR nullif(
                  to_jsonb(ti)->>'ready_at',''
              ) IS NOT NULL

              OR nullif(
                  to_jsonb(ti)->>'served_at',''
              ) IS NOT NULL

          )

    ) THEN

        RETURN true;

    END IF;

    -- Actual liquid consumption is irreversible
    -- through ordinary sealed-stock restoration.

    IF EXISTS (

        SELECT 1

        FROM public.stock_container_events ce

        WHERE ce.organization_id = _org

          AND ce.reference_type = 'pos_order_item'

          AND ce.reference_id = _item

          AND ce.event_type = 'pour'

          AND ce.volume_delta_ml < 0

    ) THEN

        RETURN true;

    END IF;

    RETURN false;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_item_preparation_started(
    uuid,uuid,uuid
)
FROM PUBLIC,anon,authenticated;

-- ============================================================
-- CORRECT EXISTING CANCELLATION CLASSIFICATION
-- ============================================================

DO $migration$
DECLARE

    d text;

    original_block text;

    replacement_block text;

BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_item_void_effect()'
        ::regprocedure
    );

    original_block := $old$
  v_prepared :=
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
      );
$old$;

    replacement_block := $new$

  -- neo_actual_preparation_evidence_v1

  v_prepared :=

      NEW.served_at IS NOT NULL

      OR OLD.served_at IS NOT NULL

      OR NEW.ready_at IS NOT NULL

      OR OLD.ready_at IS NOT NULL

      OR OLD.status IN (
          'preparing',
          'ready',
          'served',
          'completed'
      )

      OR public.neo_pos_item_preparation_started(
          NEW.organization_id,
          NEW.order_id,
          NEW.id
      );

  -- Historical items without production evidence require
  -- conservative treatment rather than speculative restocking.

  IF NOT v_prepared

     AND NOT COALESCE(v_direct,false)

     AND (
         NEW.sent_at IS NOT NULL
         OR OLD.sent_at IS NOT NULL
     )

     AND NOT EXISTS (

         SELECT 1

         FROM public.station_ticket_items ti

         JOIN public.station_tickets t
           ON t.id = ti.ticket_id
          AND t.organization_id = NEW.organization_id

         WHERE ti.organization_id = NEW.organization_id

           AND ti.order_item_id = NEW.id

           AND t.order_id = NEW.order_id

     )

  THEN

      v_prepared := true;

  END IF;

$new$;

    IF position(
        btrim(original_block) IN d
    ) = 0 THEN

        RAISE EXCEPTION
            'Canonical cancellation classification differs';

    END IF;

    d := replace(
        d,
        btrim(original_block),
        replacement_block
    );

    EXECUTE d;

END;
$migration$;

COMMIT;