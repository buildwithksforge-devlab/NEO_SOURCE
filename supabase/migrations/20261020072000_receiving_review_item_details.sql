-- Add item identity to independent receiving review.

-- Preserves authorization and delivered-quantity excess checks.

BEGIN;

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
                                'item_name', COALESCE(
                                    (
                                        SELECT si.name
                                        FROM public.stock_items si
                                        WHERE si.id = pl.stock_item_id
                                          AND si.organization_id = v_org
                                    ),
                                    pl.description,
                                    'Unidentified item'
                                ),
                                'unit', pl.unit,

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
