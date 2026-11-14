-- Wave 1 repair derived from local source 9d18edc. No historical rows are changed.
-- Compare the deployment and reproduce in isolated UAT before applying.
BEGIN;
DO $neo_guard$
BEGIN
  IF replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.neo_grn_retry_accrual(uuid)'::regprocedure), E'\r\n', E'\n')
     IS DISTINCT FROM replace($neo_expected$
DECLARE v_org uuid := public.current_org_id(); r public.goods_receipts; v_res jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.neo_branch_in_scope(r.branch_id) THEN
    RAISE EXCEPTION 'This delivery belongs to another property' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('finance','journals.post')
          OR public.has_permission('finance','post')
          OR public.has_permission('procurement','grn.post')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post this delivery to finance' USING ERRCODE='42501';
  END IF;
  IF r.accrual_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', r.accrual_journal_id);
  END IF;

  v_res := public.neo_grn_post_accrual(_receipt);
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'retried', true);
END $neo_expected$, E'\r\n', E'\n') THEN
    RAISE EXCEPTION 'Function differs from reviewed local source; inspect deployment before applying this repair';
  END IF;
END
$neo_guard$;
CREATE OR REPLACE FUNCTION public.neo_grn_retry_accrual(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid := public.current_org_id(); r public.goods_receipts; v_res jsonb;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt AND organization_id = v_org;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF NOT public.neo_branch_in_scope(r.branch_id) THEN
    RAISE EXCEPTION 'This delivery belongs to another property' USING ERRCODE='42501';
  END IF;
  IF NOT (public.has_permission('finance','journals.post')
          OR public.has_permission('finance','post')
          OR public.has_permission('procurement','grn.post')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to post this delivery to finance' USING ERRCODE='42501';
  END IF;
  IF r.accrual_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', r.accrual_journal_id);
  END IF;

  v_res := public.neo_grn_post_accrual(_receipt);
  IF v_res IS NULL OR v_res->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Delivery accrual was not posted: %',
      coalesce(v_res->>'message', v_res->>'error', 'No successful posting result was returned');
  END IF;
  IF nullif(v_res->>'journal_id', '') IS NULL
     AND coalesce(v_res->>'skipped', '') <> 'zero_value' THEN
    RAISE EXCEPTION 'Delivery accrual was not posted: no journal reference was returned';
  END IF;
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'retried', true);
END $function$;
COMMIT;
