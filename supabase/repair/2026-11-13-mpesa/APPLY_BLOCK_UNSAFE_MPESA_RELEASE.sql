BEGIN;
DO $guard$
BEGIN
 IF md5(pg_get_functiondef(to_regprocedure('public.neo_mpesa_release_attempt(uuid,text)'))) IS DISTINCT FROM '407994f63cb96fb2fbf8e29ad2b771e6' THEN
  RAISE EXCEPTION 'Release definition differs from reviewed export; stop and inspect before applying';
 END IF;
END;
$guard$;
CREATE OR REPLACE FUNCTION public.neo_mpesa_release_attempt(_transaction uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
 RAISE EXCEPTION 'Manual release is disabled: a missing Safaricom reference does not prove this attempt was not sent. Reconcile provider evidence before another collection.' USING ERRCODE='55000';
END;
$function$;
SELECT jsonb_build_object('diagnostic_version','mpesa-unsafe-release-contained-v1','release_disabled',position('Manual release is disabled' in pg_get_functiondef('public.neo_mpesa_release_attempt(uuid,text)'::regprocedure))>0,'scope','Blocks manual release only. No attempt, payment, credentials, bridge flags or historical record changed.') AS result;
COMMIT;
