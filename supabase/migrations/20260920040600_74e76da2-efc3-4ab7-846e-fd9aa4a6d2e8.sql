CREATE OR REPLACE FUNCTION public.neo_guard_maker_checker_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new jsonb := to_jsonb(NEW);
  _old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  _creator uuid; _approver uuid; _prev_approver uuid; _org uuid;
  _exception public.self_approval_exceptions%ROWTYPE;
BEGIN
  -- Journals raised by the modules themselves (accruals, reversals) are machine
  -- postings of an already-approved business document, not a human approving
  -- their own record. Maker/checker stays in force for manual journals.
  IF COALESCE(NEW.journal_type,'') IN ('automatic','reversal') AND NEW.source_module IS NOT NULL THEN
    RETURN NEW;
  END IF;

  _creator := NULLIF(_new ->> 'created_by', '')::uuid;
  _approver := NULLIF(_new ->> 'posted_by', '')::uuid;
  _prev_approver := NULLIF(_old ->> 'posted_by', '')::uuid;

  IF _approver IS NULL OR _creator IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND _prev_approver IS NOT DISTINCT FROM _approver THEN RETURN NEW; END IF;
  IF _approver IS DISTINCT FROM _creator THEN RETURN NEW; END IF;

  _org := NULLIF(_new ->> 'organization_id', '')::uuid;
  IF _org IS NOT NULL THEN
    SELECT * INTO _exception FROM public.self_approval_exceptions e
     WHERE e.organization_id = _org AND e.workflow_key = TG_TABLE_NAME AND e.active
       AND e.effective_from <= current_date
       AND (e.effective_to IS NULL OR e.effective_to >= current_date)
     LIMIT 1;

    BEGIN
      INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id,
        previous_value, new_value, reason)
      VALUES (_org, auth.uid(), '',
        CASE WHEN _exception.id IS NULL THEN 'governance.self_approval_blocked'
             ELSE 'governance.self_approval_exception_used' END,
        'governance', COALESCE(_new ->> 'id', ''),
        jsonb_build_object('table', TG_TABLE_NAME, 'creator', _creator),
        jsonb_build_object('table', TG_TABLE_NAME, 'creator', _creator, 'approver', _approver,
          'actor', auth.uid(), 'exception_id', _exception.id),
        COALESCE(_exception.reason, 'Maker/checker separation: the person who raised this record cannot approve it.'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF _exception.id IS NULL THEN
    RAISE EXCEPTION 'This record was raised by you, so it must be approved by somebody else. Route it to an independent approver.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_maker_checker_journal_entries ON public.journal_entries;
CREATE TRIGGER neo_maker_checker_journal_entries
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.neo_guard_maker_checker_journal();

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
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'retried', true);
END $function$;

REVOKE ALL ON FUNCTION public.neo_grn_retry_accrual(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_grn_retry_accrual(uuid) TO authenticated;