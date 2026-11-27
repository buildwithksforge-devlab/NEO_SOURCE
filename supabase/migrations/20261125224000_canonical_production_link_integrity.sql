BEGIN;


-- ============================================================
-- Scoped production coverage evidence.
--
-- This function does not modify production, stock or bills.
-- It provides authoritative evidence for the application.
-- ============================================================

CREATE FUNCTION public.neo_order_production_coverage(
    _order uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    o public.pos_orders;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
    THEN

        RAISE EXCEPTION
            'Production coverage is outside authorised access'
            USING ERRCODE = '42501';

    END IF;

    SELECT * INTO o

    FROM public.pos_orders

    WHERE id = _order
      AND organization_id = v_org;

    IF NOT FOUND
       OR o.branch_id IS NULL
       OR public.neo_branch_in_scope(o.branch_id) IS NOT TRUE
       OR NOT coalesce(
           public.in_my_scope(
               o.organization_id,
               o.branch_id,
               o.department_id,
               o.station_id,
               o.waiter_id,
               o.created_by
           )
           OR public.is_shared_with_me('pos_order',o.id),
           false
       )
    THEN

        RAISE EXCEPTION
            'Order is outside authorised access'
            USING ERRCODE = '42501';

    END IF;

    RETURN jsonb_build_object(

        'ok',true,

        'order_id',o.id,

        'items',(

            SELECT coalesce(

                jsonb_agg(

                    jsonb_build_object(

                        'order_item_id',oi.id,

                        'commercial_status',oi.status,

                        'primary_station_id',oi.station_id,

                        'required_station_ids',(

                            SELECT coalesce(
                                jsonb_agg(
                                    DISTINCT r.station_id
                                ),
                                '[]'::jsonb
                            )

                            FROM public.neo_pos_production_requirements r

                            WHERE r.organization_id = v_org
                              AND r.order_id = o.id
                              AND r.order_item_id = oi.id
                              AND r.branch_id IS NOT DISTINCT FROM
                                  o.branch_id

                        ),

                        'cancellation_pending',EXISTS (
                            SELECT 1

                            FROM public.pos_void_requests r

                            WHERE r.organization_id = v_org
                              AND r.order_id = o.id
                              AND r.order_item_id = oi.id
                              AND r.status = 'pending'
                        ),

                        'production_tasks',(

                            SELECT coalesce(

                                jsonb_agg(

                                    jsonb_build_object(

                                        'ticket_id',t.id,

                                        'ticket_item_id',sti.id,

                                        'station_id',t.station_id,

                                        'status',sti.status,

                                        'remake_of_id',sti.remake_of_id,

                                        'accepted_at',sti.accepted_at,

                                        'started_at',sti.started_at,

                                        'ready_at',sti.ready_at,

                                        'collected_at',sti.collected_at,

                                        'served_at',sti.served_at

                                    )

                                    ORDER BY sti.id

                                ),

                                '[]'::jsonb

                            )

                            FROM public.station_ticket_items sti

                            JOIN public.station_tickets t
                              ON t.id = sti.ticket_id
                             AND t.organization_id =
                                 sti.organization_id

                            WHERE sti.organization_id = v_org
                              AND sti.order_item_id = oi.id
                              AND t.order_id = o.id
                              AND t.branch_id IS NOT DISTINCT FROM
                                  o.branch_id

                        )

                    )

                    ORDER BY oi.created_at,oi.id

                ),

                '[]'::jsonb

            )

            FROM public.pos_order_items oi

            WHERE oi.organization_id = v_org
              AND oi.order_id = o.id

        )

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_order_production_coverage(uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_order_production_coverage(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_captured_production_stage_complete(
    _org uuid,
    _order uuid,
    _item uuid,
    _stage text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_branch uuid;
    v_allowed text[];
BEGIN

    IF _stage = 'ready' THEN

        v_allowed := ARRAY[
            'ready','collected','served','completed'
        ];

    ELSIF _stage = 'served' THEN

        v_allowed := ARRAY[
            'served','completed'
        ];

    ELSE

        RAISE EXCEPTION 'Unsupported production stage';

    END IF;

    SELECT o.branch_id
    INTO v_branch
    FROM public.pos_orders o
    WHERE o.id = _order
      AND o.organization_id = _org;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.pos_order_items i
        WHERE i.id = _item
          AND i.organization_id = _org
          AND i.order_id = _order
    ) THEN
        RETURN false;
    END IF;

    -- Historical records retain the existing canonical guard.

    IF NOT EXISTS (

        SELECT 1
        FROM public.neo_pos_production_requirements r
        WHERE r.organization_id = _org
          AND r.order_id = _order
          AND r.order_item_id = _item
          AND r.branch_id IS NOT DISTINCT FROM v_branch

    ) THEN
        RETURN true;
    END IF;

    IF NOT EXISTS (

        SELECT 1
        FROM public.neo_pos_production_requirements r
        WHERE r.organization_id = _org
          AND r.order_id = _order
          AND r.order_item_id = _item
          AND r.branch_id IS NOT DISTINCT FROM v_branch
          AND r.requirement_role = 'primary'

    ) THEN
        RETURN false;
    END IF;

    RETURN NOT EXISTS (

        SELECT 1
        FROM public.neo_pos_production_requirements r

        WHERE r.organization_id = _org
          AND r.order_id = _order
          AND r.order_item_id = _item
          AND r.branch_id IS NOT DISTINCT FROM v_branch

          AND (

              (
                  SELECT count(*)

                  FROM public.station_ticket_items i

                  JOIN public.station_tickets t
                    ON t.id = i.ticket_id
                   AND t.organization_id = _org

                  WHERE i.organization_id = _org
                    AND i.order_item_id = _item
                    AND i.remake_of_id IS NULL
                    AND t.order_id = _order
                    AND t.station_id = r.station_id
                    AND t.branch_id IS NOT DISTINCT FROM v_branch

              ) <> 1

              OR NOT EXISTS (

                  SELECT 1

                  FROM public.station_ticket_items i

                  JOIN public.station_tickets t
                    ON t.id = i.ticket_id
                   AND t.organization_id = _org

                  WHERE i.organization_id = _org
                    AND i.order_item_id = _item
                    AND i.remake_of_id IS NULL
                    AND t.order_id = _order
                    AND t.station_id = r.station_id
                    AND t.branch_id IS NOT DISTINCT FROM v_branch
                    AND i.status = ANY(v_allowed)
                    AND coalesce(t.status,'') NOT IN (
                        'cancelled','voided'
                    )

              )

              OR EXISTS (

                  SELECT 1

                  FROM public.station_ticket_items i

                  JOIN public.station_tickets t
                    ON t.id = i.ticket_id
                   AND t.organization_id = _org

                  WHERE i.organization_id = _org
                    AND i.order_item_id = _item
                    AND i.remake_of_id IS NOT NULL
                    AND t.order_id = _order
                    AND t.station_id = r.station_id
                    AND coalesce(i.status,'') NOT IN (
                        'completed','cancelled','voided'
                    )

              )

          )

    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_captured_production_stage_complete(
    uuid,uuid,uuid,text
)
FROM PUBLIC,anon,authenticated;

DO $migration$
DECLARE

    d text;

    service_anchor text :=
        '  UPDATE public.station_ticket_items SET';

    parent_anchor text :=
        '  -- ORIGINAL POS STATUS PROPAGATION';

BEGIN

    d := pg_get_functiondef(
        'public.neo_kitchen_item_transition(uuid,text,text)'
        ::regprocedure
    );

    IF position(
        'neo_multistation_readiness_guard_v1' IN d
    ) = 0

       OR position(service_anchor IN d) = 0

       OR position(parent_anchor IN d) = 0

    THEN

        RAISE EXCEPTION
            'Canonical production transition differs';

    END IF;

    d := replace(

        d,

        service_anchor,

$patch$

  -- neo_captured_requirement_service_guard_v1

  IF _ti.order_item_id IS NOT NULL
     AND _ti.remake_of_id IS NULL
     AND _to IN ('collected','served','completed')
  THEN

    IF public.neo_captured_production_stage_complete(
        _org,
        _t.order_id,
        _ti.order_item_id,
        'ready'
    ) IS NOT TRUE THEN

      RAISE EXCEPTION
          'Required production stations are not all ready'
          USING ERRCODE = '23514';

    END IF;

  END IF;

$patch$

        || service_anchor

    );

    d := replace(

        d,

        parent_anchor,

$patch$

  -- neo_captured_requirement_parent_guard_v1

  IF _ti.order_item_id IS NOT NULL
     AND _order_state IN ('ready','served')
  THEN

    IF public.neo_captured_production_stage_complete(
        _org,
        _t.order_id,
        _ti.order_item_id,
        _order_state
    ) IS NOT TRUE THEN

      _order_state := NULL;

    END IF;

  END IF;

$patch$

        || parent_anchor

    );

    EXECUTE d;

END;
$migration$;

COMMIT;
