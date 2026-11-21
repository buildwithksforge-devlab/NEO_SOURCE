-- STAGED ONLY: preserve installed owner/grants; refuse unreviewed definitions.
-- No stock, purchase, payment or document identity is created by installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.neo_blind_receiving_approved_queue()') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('322c6b4d910d040b752d372bbd2aad42','976aa7a9092211b2b29eb8639d83872d')) THEN
 RAISE EXCEPTION 'Receiving queue differs from reviewed source; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_receiving_document_acl ON COMMIT DROP AS
 SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_blind_receiving_approved_queue()'::regprocedure;
CREATE OR REPLACE FUNCTION public.neo_blind_receiving_approved_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT coalesce(public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage'), false) THEN
        RAISE EXCEPTION 'Authorized inventory posting access required'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'purchase_order_id', c.purchase_order_id,
                'branch_id', c.branch_id,
                'order_number', po.order_number,
                'delivery_note', c.supplier_delivery_note,
                'submitted_at', c.submitted_at,
                'reviewed_at', c.reviewed_at,
                'review_notes', c.review_notes,
                'status', c.status,
                'line_count', (
                    SELECT count(*)
                    FROM public.neo_blind_receiving_count_lines cl
                    WHERE cl.count_id = c.id
                ),
                'posting_block_reason', CASE
                    WHEN lower(concat_ws(
                        ' ',
                        c.supplier_delivery_note,
                        c.remarks,
                        c.review_notes
                    )) LIKE ANY (ARRAY[
                        '%virtual test only%',
                        '%no actual goods%',
                        '%no real goods%',
                        '%no physical goods%',
                        '%simulation only%',
                        '%no supplier commitment%'
                    ])
                    THEN 'This count is marked as virtual/test-only; inventory posting is prohibited.'
                    ELSE NULL
                END
            )
            ORDER BY c.reviewed_at
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
      AND c.status = 'approved'
      AND c.posted_grn_id IS NULL
      AND public.neo_branch_in_scope(c.branch_id)
      AND c.submitted_by <> auth.uid();

    RETURN v_result;
END;
$function$;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_receiving_document_acl old
 WHERE p.oid='public.neo_blind_receiving_approved_queue()'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Receiving queue owner or grants changed';
 END IF;
END $verify$;
COMMIT;
