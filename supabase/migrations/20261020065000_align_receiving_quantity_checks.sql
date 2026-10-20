-- Align approval and review classification with the existing delivered-quantity posting cap.

-- Does not change existing counts, approve deliveries or post stock.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_decide(_count_id uuid, _decision text, _notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_count record;
    v_excess integer;
    v_lines integer;
    v_decision text := lower(btrim(_decision));
    v_notes text := NULLIF(btrim(_notes), '');
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION 'Independent review authorization required'
            USING ERRCODE = '42501';
    END IF;

    IF v_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be approved or rejected'
            USING ERRCODE = '22023';
    END IF;

    IF v_notes IS NULL THEN
        RAISE EXCEPTION 'A review reason is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT c.*
    INTO v_count
    FROM public.neo_blind_receiving_counts c
    WHERE c.id = _count_id
      AND c.organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Blind receiving count not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_count.branch_id) THEN
        RAISE EXCEPTION 'Count is outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You cannot review your own receiving count'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.status NOT IN ('submitted', 'under_review') THEN
        RAISE EXCEPTION 'This count has already been decided'
            USING ERRCODE = '22023';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (
            WHERE
                cl.quantity_delivered
                >
                GREATEST(
                    COALESCE(pl.quantity, 0)
                    - COALESCE(pl.received_quantity, 0)
                    - COALESCE(pl.cancelled_quantity, 0),
                    0
                )
        )
    INTO v_lines, v_excess
    FROM public.neo_blind_receiving_count_lines cl
    JOIN public.purchase_order_lines pl
      ON pl.id = cl.purchase_order_line_id
     AND pl.order_id = v_count.purchase_order_id
    WHERE cl.count_id = _count_id;

    IF v_lines = 0 THEN
        RAISE EXCEPTION 'Cannot review a count without lines'
            USING ERRCODE = '22023';
    END IF;

    IF v_decision = 'approved' AND v_excess > 0 THEN
        RAISE EXCEPTION
            'Excess quantities require a separate exception authorization; approval blocked'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.neo_blind_receiving_counts
    SET
        status = v_decision,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = v_notes
    WHERE id = _count_id;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', _count_id,
        'status', v_decision,
        'reviewed_by', auth.uid(),
        'stock_posted', false,
        'finance_posted', false
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_review_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN

    -------------------------------------------------------
    -- AUTHENTICATION
    -------------------------------------------------------

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION
            'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- INDEPENDENT REVIEW ACCESS
    --
    -- Intentionally restricted to organization admins
    -- until Procurement reviewer permissions are verified.
    -------------------------------------------------------

    IF NOT public.is_org_admin() THEN
        RAISE EXCEPTION
            'Independent receiving review requires administrator authorization'
            USING ERRCODE = '42501';
    END IF;

    -------------------------------------------------------
    -- REVIEW QUEUE
    -------------------------------------------------------

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'purchase_order_id', c.purchase_order_id,
                'order_number', po.order_number,
                'branch_id', c.branch_id,
                'delivery_note', c.supplier_delivery_note,
                'submitted_by', c.submitted_by,
                'submitted_at', c.submitted_at,
                'status', c.status,
                'remarks', c.remarks,
                'lines', (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'count_line_id', cl.id,
                                'order_line_id', pl.id,

                                'ordered_quantity',
                                    pl.quantity,

                                'previously_received',
                                    COALESCE(
                                        pl.received_quantity, 0
                                    ),

                                'cancelled_quantity',
                                    COALESCE(
                                        pl.cancelled_quantity, 0
                                    ),

                                'outstanding_quantity',
                                    GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(
                                            pl.received_quantity, 0
                                          )
                                        - COALESCE(
                                            pl.cancelled_quantity, 0
                                          ),
                                        0
                                    ),

                                'physically_delivered',
                                    cl.quantity_delivered,

                                'rejected_quantity',
                                    cl.quantity_rejected,

                                'accepted_quantity',
                                    (
                                        cl.quantity_delivered
                                        - cl.quantity_rejected
                                    ),

                                'difference',
                                    (
                                        cl.quantity_delivered
                                        - cl.quantity_rejected
                                    )
                                    -
                                    GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(
                                            pl.received_quantity, 0
                                          )
                                        - COALESCE(
                                            pl.cancelled_quantity, 0
                                          ),
                                        0
                                    ),

                                'rejection_reason',
                                    cl.rejection_reason,

                                'batch_number',
                                    cl.batch_number,

                                'expiry_date',
                                    cl.expiry_date,

                                'reconciliation_result',
                                    CASE
                                        WHEN cl.quantity_delivered >
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(
                                                pl.received_quantity, 0
                                              )
                                            - COALESCE(
                                                pl.cancelled_quantity, 0
                                              ),
                                            0
                                        )
                                        THEN 'excess'

                                        WHEN (
                                            cl.quantity_delivered
                                            - cl.quantity_rejected
                                        ) <
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(
                                                pl.received_quantity, 0
                                              )
                                            - COALESCE(
                                                pl.cancelled_quantity, 0
                                              ),
                                            0
                                        )
                                        THEN 'partial_delivery'

                                        ELSE 'matched'
                                    END
                            )
                            ORDER BY cl.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.neo_blind_receiving_count_lines cl
                    JOIN public.purchase_order_lines pl
                      ON pl.id = cl.purchase_order_line_id
                     AND pl.order_id = c.purchase_order_id
                    WHERE cl.count_id = c.id
                )
            )
            ORDER BY c.submitted_at
        ),
        '[]'::jsonb
    )
    INTO v_result

    FROM public.neo_blind_receiving_counts c

    JOIN public.purchase_orders po
      ON po.id = c.purchase_order_id
     AND po.organization_id = v_org
     AND po.branch_id = c.branch_id

    WHERE c.organization_id = v_org

      AND c.status IN (
          'submitted',
          'under_review'
      )

      AND public.neo_branch_in_scope(c.branch_id)

      -- The person who counted cannot review their own count.
      AND c.submitted_by <> auth.uid();

    RETURN v_result;

END;
$function$;

COMMIT;
