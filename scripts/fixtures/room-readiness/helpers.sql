CREATE OR REPLACE FUNCTION public.hk_canonical_condition(_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT CASE lower(btrim(replace(replace(coalesce(_value,'dirty'),'_','-'),' ','-')))
    WHEN 'cleaning' THEN 'cleaning_in_progress'
    WHEN 'in-progress' THEN 'cleaning_in_progress'
    WHEN 'cleaning-in-progress' THEN 'cleaning_in_progress'
    WHEN 'being-cleaned' THEN 'cleaning_in_progress'
    WHEN 'cleaning-queued' THEN 'cleaning_queued'
    WHEN 'queued' THEN 'cleaning_queued'
    WHEN 'awaiting-inspection' THEN 'awaiting_inspection'
    WHEN 'ready-for-inspection' THEN 'awaiting_inspection'
    WHEN 'vacant-dirty' THEN 'dirty'
    WHEN 'soiled' THEN 'dirty'
    WHEN 'cleaned' THEN 'clean'
    WHEN 'vacant-clean' THEN 'clean'
    WHEN 'inspected' THEN 'inspected'
    WHEN 'rework' THEN 'rework'
    WHEN 'rework-required' THEN 'rework'
    WHEN 'failed' THEN 'rework'
    WHEN 'out-of-service' THEN 'out_of_service'
    WHEN 'clean' THEN 'clean'
    WHEN 'dirty' THEN 'dirty'
    ELSE lower(btrim(replace(replace(coalesce(_value,'dirty'),'-','_'),' ','_')))
  END;
$function$;

CREATE OR REPLACE FUNCTION public.hk_job_is_open(_status text, _superseded_by uuid)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT _superseded_by IS NULL
     AND coalesce(_status,'') NOT IN ('completed','cancelled','superseded');
$function$;
