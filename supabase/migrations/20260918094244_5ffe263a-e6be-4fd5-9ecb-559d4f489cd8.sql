
CREATE OR REPLACE FUNCTION public.neo_guard_maker_checker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _new jsonb := to_jsonb(NEW);
  _old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  _creator uuid;
  _approver uuid;
  _prev_approver uuid;
  _org uuid;
  _exception public.self_approval_exceptions%ROWTYPE;
BEGIN
  _creator := NULLIF(_new ->> TG_ARGV[0], '')::uuid;
  _approver := NULLIF(_new ->> TG_ARGV[1], '')::uuid;
  _prev_approver := NULLIF(_old ->> TG_ARGV[1], '')::uuid;

  IF _approver IS NULL OR _creator IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND _prev_approver IS NOT DISTINCT FROM _approver THEN RETURN NEW; END IF;
  IF _approver IS DISTINCT FROM _creator THEN RETURN NEW; END IF;

  _org := NULLIF(_new ->> 'organization_id', '')::uuid;

  IF _org IS NOT NULL THEN
    SELECT * INTO _exception
    FROM public.self_approval_exceptions e
    WHERE e.organization_id = _org
      AND e.workflow_key = TG_TABLE_NAME
      AND e.active
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
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the refusal must stand even when the log line cannot be written
    END;
  END IF;

  IF _exception.id IS NULL THEN
    RAISE EXCEPTION 'This record was raised by you, so it must be approved by somebody else. Route it to an independent approver.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION public.neo_guard_maker_checker() FROM PUBLIC, anon, authenticated;
