BEGIN;

CREATE TABLE public.neo_pos_handoff_failures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    branch_id uuid,
    order_id uuid NOT NULL
        REFERENCES public.pos_orders(id),
    attempt_id uuid NOT NULL,
    attempted_by uuid,
    failure_reason text NOT NULL,
    failure_sqlstate text,
    recovery_status text NOT NULL DEFAULT 'unresolved'
        CHECK (
            recovery_status IN (
                'unresolved',
                'reviewed',
                'routing-retried'
            )
        ),
    attempts integer NOT NULL DEFAULT 1
        CHECK (attempts > 0),
    first_failed_at timestamptz NOT NULL DEFAULT now(),
    last_failed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id,order_id,attempt_id)
);

CREATE TABLE public.neo_pos_handoff_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    failure_id uuid NOT NULL
        REFERENCES public.neo_pos_handoff_failures(id),
    reviewed_by uuid NOT NULL,
    review_note text NOT NULL
        CHECK (length(btrim(review_note)) BETWEEN 3 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX neo_pos_handoff_failures_scope_idx
ON public.neo_pos_handoff_failures(
    organization_id,branch_id,recovery_status,last_failed_at
);

CREATE INDEX neo_pos_handoff_reviews_failure_idx
ON public.neo_pos_handoff_reviews(
    organization_id,failure_id,created_at
);

ALTER TABLE public.neo_pos_handoff_failures
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.neo_pos_handoff_reviews
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_pos_handoff_failures
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON public.neo_pos_handoff_reviews
FROM PUBLIC,anon,authenticated;


-- Central supervisor authority.

CREATE FUNCTION public.neo_can_review_pos_handoff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
    SELECT auth.uid() IS NOT NULL
       AND public.current_org_id() IS NOT NULL
       AND (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'restaurant','orders.manage'
           ) IS TRUE
           OR public.has_permission(
               'kitchen','queue.manage'
           ) IS TRUE
       );
$function$;

REVOKE ALL ON FUNCTION
public.neo_can_review_pos_handoff()
FROM PUBLIC,anon,authenticated;


-- Preserve the installed production routing function.
-- Patch only its confirmed internal routing call.

DO $migration$
DECLARE
    d text;
    anchor text :=
        '_res := public.neo_pos_route_tickets_internal(_order, _org);';
    replacement text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_pos_send_to_kitchen(uuid,uuid)'::regprocedure
    );

    IF (
        length(d) - length(replace(d,anchor,''))
    ) / length(anchor) <> 1 THEN

        RAISE EXCEPTION
            'Installed POS routing definition differs from the verified integration point';

    END IF;

    replacement := $patch$
    BEGIN

        _res := public.neo_pos_route_tickets_internal(
            _order,_org
        );

        IF _res->>'ok' = 'false' THEN
            RAISE EXCEPTION
                'Production routing returned an unsuccessful outcome';
        END IF;

    EXCEPTION WHEN OTHERS THEN

        INSERT INTO public.neo_pos_handoff_failures (
            organization_id,
            branch_id,
            order_id,
            attempt_id,
            attempted_by,
            failure_reason,
            failure_sqlstate
        )
        VALUES (
            _org,
            _o.branch_id,
            _order,
            _attempt,
            auth.uid(),
            left(SQLERRM,2000),
            SQLSTATE
        )
        ON CONFLICT (
            organization_id,order_id,attempt_id
        )
        DO UPDATE SET
            attempts =
                neo_pos_handoff_failures.attempts + 1,
            last_failed_at = now(),
            failure_reason = EXCLUDED.failure_reason,
            failure_sqlstate = EXCLUDED.failure_sqlstate,
            recovery_status = 'unresolved';

        RETURN jsonb_build_object(
            'ok',false,
            'status','handoff_failed',
            'order_id',_order,
            'attempt',_attempt,
            'message',
                CASE
    WHEN SQLERRM LIKE 'routing_unresolved:%'
      OR SQLERRM LIKE 'store_unmapped:%'
    THEN left(SQLERRM,500)
    ELSE 'Production handoff failed. Supervisor review required.'
END
        );

    END;

    UPDATE public.neo_pos_handoff_failures
       SET recovery_status = 'routing-retried'
     WHERE organization_id = _org
       AND order_id = _order
       AND recovery_status IN ('unresolved','reviewed');
$patch$;

    EXECUTE replace(d,anchor,replacement);

END;
$migration$;


-- RPC 1: Supervisor recovery queue.

CREATE FUNCTION public.neo_pos_handoff_recovery_queue(
    _branch uuid DEFAULT NULL,
    _limit integer DEFAULT 100
)
RETURNS TABLE (
    failure_id uuid,
    order_id uuid,
    order_status text,
    recovery_status text,
    failure_reason text,
    attempts integer,
    first_failed_at timestamptz,
    order_item_count bigint,
    routed_item_count bigint,
    ticket_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
BEGIN

    IF NOT public.neo_can_review_pos_handoff() THEN
        RAISE EXCEPTION 'Supervisor authority required'
            USING ERRCODE = '42501';
    END IF;

    IF _branch IS NOT NULL
       AND public.neo_branch_in_scope(_branch)
           IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Property outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY

    SELECT
        f.id,
        f.order_id,
        o.status::text,
        f.recovery_status,
        f.failure_reason,
        f.attempts,
        f.first_failed_at,

        (
            SELECT count(*)
            FROM public.pos_order_items i
            WHERE i.order_id = o.id
              AND i.organization_id = f.organization_id
        ),

        (
            SELECT count(*)
            FROM public.pos_order_items i
            WHERE i.order_id = o.id
              AND i.organization_id = f.organization_id
              AND i.sent_at IS NOT NULL
        ),

        NULL::bigint

    FROM public.neo_pos_handoff_failures f

    JOIN public.pos_orders o
      ON o.id = f.order_id
     AND o.organization_id = f.organization_id

    WHERE f.organization_id = public.current_org_id()
      AND f.branch_id IS NOT DISTINCT FROM o.branch_id
      AND public.neo_branch_in_scope(f.branch_id) IS TRUE
      AND (_branch IS NULL OR f.branch_id = _branch)
      AND f.recovery_status IN ('unresolved','reviewed','routing-retried')

    ORDER BY f.last_failed_at DESC,f.id DESC

    LIMIT greatest(1,least(coalesce(_limit,100),500));

END;
$function$;


-- RPC 2: Full investigation evidence.
-- Unknown station coverage must remain unverified.

CREATE FUNCTION public.neo_pos_handoff_full_investigation(
    _failure_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    f public.neo_pos_handoff_failures;
    v_items jsonb;
    v_reviews jsonb;
    v_total integer;
BEGIN

    IF NOT public.neo_can_review_pos_handoff() THEN
        RAISE EXCEPTION 'Supervisor authority required'
            USING ERRCODE = '42501';
    END IF;

    SELECT x.* INTO f
    FROM public.neo_pos_handoff_failures x
    WHERE x.id = _failure_id
      AND x.organization_id = public.current_org_id()
      AND public.neo_branch_in_scope(x.branch_id) IS TRUE;

    IF f.id IS NULL THEN
        RAISE EXCEPTION 'Handoff failure not found'
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'order_item_id',i.id,
               'item_name',i.item_name,
               'item_status',i.status,
               'quantity',i.quantity,
               'coverage_status','requires-review',
               'snapshot_count',NULL,
               'successful_postings',(
                   SELECT count(*)
                   FROM public.inventory_posting_events e
                   WHERE e.organization_id = f.organization_id
                     AND e.order_id = f.order_id
                     AND e.order_item_id = i.id
                     AND e.status = 'posted'
               ),
               'failed_postings',(
                   SELECT count(*)
                   FROM public.inventory_posting_events e
                   WHERE e.organization_id = f.organization_id
                     AND e.order_id = f.order_id
                     AND e.order_item_id = i.id
                     AND e.status = 'failed'
               )
           )),'[]'::jsonb)
    INTO v_total,v_items
    FROM public.pos_order_items i
    WHERE i.organization_id = f.organization_id
      AND i.order_id = f.order_id;

    SELECT coalesce(
        jsonb_agg(
            to_jsonb(r)
            ORDER BY r.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_reviews
    FROM public.neo_pos_handoff_reviews r
    WHERE r.organization_id = f.organization_id
      AND r.failure_id = f.id;

    RETURN jsonb_build_object(
        'ok',true,
        'order_id',f.order_id,
        'recovery_status',f.recovery_status,
        'coverage_status','requires-review',
        'total_items',v_total,
        'verified_items',0,
        'items_without_tickets',NULL,
        'items_requiring_review',v_total,
        'station_coverage',
            jsonb_build_object('items',v_items),
        'routing_verified',false,
        'requires_operational_confirmation',true,
        'primary_coverage_status','unverified',
        'secondary_coverage_status','unverified',
        'supervisor_reviews',v_reviews
    );

END;
$function$;


-- RPC 3: Durable supervisor review.
-- Review does not resend orders or change inventory.

CREATE FUNCTION public.neo_pos_review_failed_handoff(
    _failure_id uuid,
    _review_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    f public.neo_pos_handoff_failures;
    v_review uuid;
BEGIN

    IF NOT public.neo_can_review_pos_handoff() THEN
        RAISE EXCEPTION 'Supervisor authority required'
            USING ERRCODE = '42501';
    END IF;

    IF _review_note IS NULL
       OR length(btrim(_review_note)) NOT BETWEEN 3 AND 2000
    THEN
        RAISE EXCEPTION 'A valid review note is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT x.* INTO f
    FROM public.neo_pos_handoff_failures x
    WHERE x.id = _failure_id
      AND x.organization_id = public.current_org_id()
      AND public.neo_branch_in_scope(x.branch_id) IS TRUE
    FOR UPDATE;

    IF f.id IS NULL THEN
        RAISE EXCEPTION 'Handoff failure not found'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.neo_pos_handoff_reviews(
        organization_id,
        failure_id,
        reviewed_by,
        review_note
    )
    VALUES(
        f.organization_id,
        f.id,
        auth.uid(),
        btrim(_review_note)
    )
    RETURNING id INTO v_review;

    UPDATE public.neo_pos_handoff_failures
       SET recovery_status = CASE
           WHEN recovery_status = 'routing-retried'
               THEN recovery_status
           ELSE 'reviewed'
       END
     WHERE id = f.id
       AND organization_id = f.organization_id;

    RETURN jsonb_build_object(
        'ok',true,
        'failure_id',f.id,
        'review_id',v_review,
        'status','review-recorded',
        'routing_verified',false
    );

END;
$function$;


REVOKE ALL ON FUNCTION
public.neo_pos_handoff_recovery_queue(uuid,integer)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_pos_handoff_full_investigation(uuid)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_pos_review_failed_handoff(uuid,text)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_pos_handoff_recovery_queue(uuid,integer)
TO authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_pos_handoff_full_investigation(uuid)
TO authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_pos_review_failed_handoff(uuid,text)
TO authenticated;

COMMIT;