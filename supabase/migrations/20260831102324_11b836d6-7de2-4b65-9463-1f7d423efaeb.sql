ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS render_status text NOT NULL DEFAULT 'rendered',
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'delivered',
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_reason text;

-- Duplicate protection must not depend on every caller remembering to pass a
-- key: a notification inserted without one dedupes on nothing at all, which is
-- how the same kitchen-ready alert reaches a recipient repeatedly.
CREATE OR REPLACE FUNCTION public.neo_notification_idempotency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
    NEW.idempotency_key :=
      coalesce(NEW.event_type, NEW.source_module, NEW.category, 'notification')
      || ':' || coalesce(NEW.source_record_id::text, md5(coalesce(NEW.title, '') || coalesce(NEW.body, '')))
      || ':' || coalesce(NEW.status, '')
      || ':' || coalesce(NEW.user_id::text, 'all');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notification_idempotency ON public.notifications;
CREATE TRIGGER trg_notification_idempotency
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.neo_notification_idempotency();

CREATE OR REPLACE FUNCTION public.neo_notify_event(_org uuid, _user uuid, _branch uuid, _event text, _record uuid DEFAULT NULL::uuid, _vars jsonb DEFAULT '{}'::jsonb, _idem text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t public.notification_templates; _title text; _body text; _link text; _k text; _missing text[]; _status text;
BEGIN
  IF _org IS NULL OR _event IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO _t FROM public.notification_templates
   WHERE event_type = _event AND active
     AND (organization_id = _org OR organization_id IS NULL)
   ORDER BY organization_id NULLS LAST LIMIT 1;
  IF _t.id IS NULL THEN RETURN NULL; END IF;

  _title := _t.title_template; _body := _t.body_template; _link := _t.link_template;
  _vars := coalesce(_vars,'{}'::jsonb) || jsonb_build_object('record', coalesce(_record::text,''));
  _status := coalesce(_vars->>'status', '');
  FOR _k IN SELECT jsonb_object_keys(_vars) LOOP
    _title := replace(_title, '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _body  := replace(_body,  '{{'||_k||'}}', coalesce(_vars->>_k,''));
    _link  := replace(coalesce(_link,''), '{{'||_k||'}}', coalesce(_vars->>_k,''));
  END LOOP;

  SELECT array_agg(DISTINCT m[1]) INTO _missing
    FROM regexp_matches(coalesce(_title,'')||' '||coalesce(_body,'')||' '||coalesce(_link,''),
                        '\{\{([a-zA-Z0-9_.]+)\}\}', 'g') AS m;

  IF _missing IS NOT NULL AND array_length(_missing,1) > 0 THEN
    INSERT INTO public.notification_render_failures
      (organization_id, branch_id, event_type, record_id, missing_variables, rendered_title, rendered_body, variables)
    VALUES (_org, _branch, _event, _record, _missing, _title, _body, _vars);
    RETURN NULL;
  END IF;

  RETURN public.neo_notify(_org, _user, _branch, _t.category, _title, _body,
    nullif(_link,''), _t.priority, _t.action_required, _t.source_module, _record, _event,
    coalesce(_idem, _event || ':' || coalesce(_record::text,'') || ':' || _status || ':' || coalesce(_user::text,'all')));
END $function$;