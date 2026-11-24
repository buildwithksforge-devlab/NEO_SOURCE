BEGIN;
DO $repair$
DECLARE
 before_row public.mpesa_settings;
 after_row public.mpesa_settings;
 matches integer;
BEGIN
 SELECT count(*) INTO matches FROM public.mpesa_settings s
 JOIN public.organizations o ON o.id=s.organization_id
 WHERE o.name='TWIN BOABAB ENTERPRISES LTD';
 IF matches<>1 THEN RAISE EXCEPTION 'Expected exactly one Mawimbi M-Pesa configuration; no change made'; END IF;
 SELECT s.* INTO before_row FROM public.mpesa_settings s
 JOIN public.organizations o ON o.id=s.organization_id
 WHERE o.name='TWIN BOABAB ENTERPRISES LTD' FOR UPDATE OF s;
 IF before_row.environment IS DISTINCT FROM 'production' OR before_row.enabled IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Mawimbi environment or enabled state differs from reviewed evidence; no change made';
 END IF;
 IF nullif(btrim(before_row.callback_token),'') IS NULL THEN
  RAISE EXCEPTION 'Existing callback token is missing; no change made';
 END IF;
 IF rtrim(btrim(before_row.callback_base_url),'/')='https://horizon-prime-os.lovable.app' THEN RETURN; END IF;
 IF coalesce(rtrim(btrim(before_row.callback_base_url),'/'),'') <> 'https://mawimbijikohotel.com' THEN
  RAISE EXCEPTION 'Saved callback base differs from reviewed failed host; no change made';
 END IF;
 UPDATE public.mpesa_settings SET callback_base_url='https://horizon-prime-os.lovable.app',updated_at=now()
 WHERE organization_id=before_row.organization_id RETURNING * INTO after_row;
 IF (to_jsonb(before_row)-'callback_base_url'-'updated_at') IS DISTINCT FROM (to_jsonb(after_row)-'callback_base_url'-'updated_at') THEN
  RAISE EXCEPTION 'An unrelated setting changed; rolling back callback correction';
 END IF;
 INSERT INTO public.audit_logs(organization_id,user_id,action,module,record_id,previous_value,new_value)
 VALUES(before_row.organization_id,auth.uid(),'integration.mpesa.callback.corrected','administration',before_row.organization_id::text,
 jsonb_build_object('callback_host','mawimbijikohotel.com'),
 jsonb_build_object('callback_host','horizon-prime-os.lovable.app','reason','Existing production callback host returned HTTP 404; managed callback rejects invalid tokens with HTTP 401. Existing token, credentials, environment and attempts preserved.'));
END;
$repair$;
SELECT jsonb_build_object('diagnostic_version','mawimbi-mpesa-callback-base-correction-v1',
 'callback_base_corrected',coalesce((SELECT s.callback_base_url='https://horizon-prime-os.lovable.app' FROM public.mpesa_settings s JOIN public.organizations o ON o.id=s.organization_id WHERE o.name='TWIN BOABAB ENTERPRISES LTD'),false),
 'scope','Corrects future Mawimbi callback routing only. No token rotation, credential change, flag change, payment, prompt, attempt release or historical rewrite. Existing prompts must be reconciled, not resent.') AS result;
COMMIT;
