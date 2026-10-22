-- NEØ E07-B: Safe requisition issue infrastructure.
-- Already executed in Supabase; retained for source control.

CREATE TABLE IF NOT EXISTS public.neo_requisition_issue_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    requisition_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    payload jsonb NOT NULL,
    result jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT neo_req_issue_attempt_unique
        UNIQUE (organization_id, requisition_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS neo_req_issue_attempt_requisition_idx
ON public.neo_requisition_issue_attempts
(organization_id, requisition_id);

ALTER TABLE public.neo_requisition_issue_attempts
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_requisition_issue_attempts
FROM PUBLIC, anon, authenticated;

-- IMPORTANT:
-- The deployed neo_req_issue_safe function definition
-- must be included below before this migration is committed.

CREATE OR REPLACE FUNCTION public.neo_req_issue_safe(
    _requisition uuid,
    _lines jsonb,
    _attempt uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_req public.internal_requisitions;
    v_line jsonb;
    v_row public.internal_requisition_lines;
    v_item public.stock_items;
    v_qty numeric;
    v_count integer := 0;
    v_partial boolean := false;
    v_prior record;
    v_result jsonb;
    v_seen uuid[] := ARRAY[]::uuid[];
    v_line_id uuid;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Staff authentication required' USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.has_permission('stores','issues','create')
        OR public.has_permission('stores','edit')
        OR public.has_permission('stores','approve')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Stores issuing permission required' USING ERRCODE = '42501';
    END IF;

    IF _attempt IS NULL THEN
        RAISE EXCEPTION 'A unique issue attempt ID is required';
    END IF;

    IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array'
       OR jsonb_array_length(_lines) = 0 THEN
        RAISE EXCEPTION 'At least one issue line is required';
    END IF;

    SELECT * INTO v_req
    FROM public.internal_requisitions
    WHERE id = _requisition AND organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition not found';
    END IF;

    IF v_req.branch_id IS NULL
       OR NOT (v_req.branch_id = ANY(public.current_branch_ids())) THEN
        RAISE EXCEPTION 'Requisition outside authorized property'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_prior
    FROM public.neo_requisition_issue_attempts
    WHERE organization_id = v_org
      AND requisition_id = _requisition
      AND attempt_id = _attempt;

    IF FOUND THEN
        IF v_prior.payload <> _lines THEN
            RAISE EXCEPTION 'Issue attempt already used with a different payload';
        END IF;

        RETURN v_prior.result || jsonb_build_object('replayed', true);
    END IF;

    IF v_req.status NOT IN (
        'ready-for-issue',
        'partially-approved',
        'partially-issued'
    ) THEN
        RAISE EXCEPTION 'Stores approval required before issuing';
    END IF;

    IF v_req.source_location_id IS NULL THEN
        RAISE EXCEPTION 'Select an issuing store';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.stock_locations s
        WHERE s.id = v_req.source_location_id
          AND s.organization_id = v_org
          AND s.branch_id = v_req.branch_id
          AND s.active IS TRUE
    ) THEN
        RAISE EXCEPTION 'Invalid issuing store for this property';
    END IF;

    IF v_req.destination_location_id IS NOT NULL THEN
        IF v_req.destination_location_id = v_req.source_location_id THEN
            RAISE EXCEPTION 'Source and destination stores must differ';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.stock_locations s
            WHERE s.id = v_req.destination_location_id
              AND s.organization_id = v_org
              AND s.branch_id = v_req.branch_id
              AND s.active IS TRUE
        ) THEN
            RAISE EXCEPTION 'Invalid destination store for this property';
        END IF;
    END IF;

    FOR v_line IN
        SELECT value FROM jsonb_array_elements(_lines)
    LOOP
        IF jsonb_typeof(v_line) <> 'object'
           OR v_line->>'id' IS NULL
           OR v_line->>'quantity_issued' IS NULL THEN
            RAISE EXCEPTION 'Invalid issue line format';
        END IF;

        v_line_id := (v_line->>'id')::uuid;

        IF v_line_id = ANY(v_seen) THEN
            RAISE EXCEPTION 'Duplicate issue line in submission';
        END IF;

        v_seen := array_append(v_seen, v_line_id);

        SELECT * INTO v_row
        FROM public.internal_requisition_lines
        WHERE id = v_line_id
          AND requisition_id = _requisition
          AND organization_id = v_org
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Requisition line not found';
        END IF;

        v_qty := (v_line->>'quantity_issued')::numeric;

        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE EXCEPTION 'Issue quantity must be positive';
        END IF;

        IF v_row.quantity_approved IS NULL THEN
            RAISE EXCEPTION 'Approve line quantities before issue';
        END IF;

        IF v_qty > (
            v_row.quantity_approved -
            COALESCE(v_row.quantity_issued, 0)
        ) THEN
            RAISE EXCEPTION 'Quantity exceeds outstanding approved amount';
        END IF;

        IF v_row.stock_item_id IS NULL THEN
            RAISE EXCEPTION 'Assign inventory item before issuing';
        END IF;

        SELECT * INTO v_item
        FROM public.stock_items
        WHERE id = v_row.stock_item_id
          AND organization_id = v_org
          AND (
              branch_id = v_req.branch_id
              OR branch_id IS NULL
          )
          AND active IS TRUE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid inventory item for this property';
        END IF;

        PERFORM public.inventory_apply_movement(
            v_row.stock_item_id,
            v_req.source_location_id,
            -v_qty,
            v_row.unit,
            CASE
                WHEN v_req.destination_location_id IS NULL THEN 'issue'
                ELSE 'transfer-out'
            END,
            NULL,
            'internal-requisition',
            _requisition,
            'Requisition stock issue',
            'req-out:' || _attempt::text || ':' || v_row.id::text
        );

        IF v_req.destination_location_id IS NOT NULL THEN
            PERFORM public.inventory_apply_movement(
                v_row.stock_item_id,
                v_req.destination_location_id,
                v_qty,
                v_row.unit,
                'transfer-in',
                NULL,
                'internal-requisition',
                _requisition,
                'Requisition stock transfer',
                'req-in:' || _attempt::text || ':' || v_row.id::text
            );
        END IF;

        UPDATE public.internal_requisition_lines
        SET quantity_issued = COALESCE(quantity_issued, 0) + v_qty
        WHERE id = v_row.id
          AND organization_id = v_org;

        v_count := v_count + 1;
    END LOOP;

    SELECT EXISTS (
        SELECT 1
        FROM public.internal_requisition_lines
        WHERE requisition_id = _requisition
          AND organization_id = v_org
          AND COALESCE(quantity_issued, 0)
              < COALESCE(quantity_approved, quantity_requested)
    )
    INTO v_partial;

    UPDATE public.internal_requisitions
    SET status = CASE
            WHEN v_partial THEN 'partially-issued'
            ELSE 'issued'
        END,
        issued_by = auth.uid(),
        issued_at = now()
    WHERE id = _requisition
      AND organization_id = v_org;

    UPDATE public.kitchen_ingredient_requests k
    SET issued_quantity = (
        SELECT COALESCE(SUM(l.quantity_issued), 0)
        FROM public.internal_requisition_lines l
        WHERE l.requisition_id = _requisition
          AND l.organization_id = v_org
    ),
    status = CASE
        WHEN v_partial THEN 'partially-available'
        ELSE 'issued'
    END,
    handled_by = auth.uid(),
    updated_at = now()
    WHERE k.stores_requisition_id = _requisition
      AND k.organization_id = v_org
      AND k.branch_id = v_req.branch_id;

    v_result := jsonb_build_object(
        'ok', true,
        'requisition_id', _requisition,
        'attempt_id', _attempt,
        'lines_issued', v_count,
        'partial', v_partial,
        'status', CASE
            WHEN v_partial THEN 'partially-issued'
            ELSE 'issued'
        END
    );

    INSERT INTO public.neo_requisition_issue_attempts (
        organization_id,
        requisition_id,
        attempt_id,
        payload,
        result,
        created_by
    )
    VALUES (
        v_org,
        _requisition,
        _attempt,
        _lines,
        v_result,
        auth.uid()
    );

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_req_issue_safe(uuid, jsonb, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neo_req_issue_safe(uuid, jsonb, uuid)
TO authenticated;