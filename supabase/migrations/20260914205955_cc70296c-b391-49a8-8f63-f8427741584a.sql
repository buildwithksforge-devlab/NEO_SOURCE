-- Deterministic period resolution: an open period always wins over a
-- duplicate marked future/closed for the same date.
CREATE OR REPLACE FUNCTION public.fin_period_for(_org uuid, _date date)
RETURNS accounting_periods
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT *
  FROM public.accounting_periods
  WHERE organization_id = _org AND _date BETWEEN starts_on AND ends_on
  ORDER BY
    CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 WHEN 'locked' THEN 2 ELSE 3 END,
    created_at DESC
  LIMIT 1;
$function$;

-- No new overlapping period may be created for the same workspace.
CREATE OR REPLACE FUNCTION public.neo_guard_period_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.accounting_periods q
     WHERE q.organization_id = NEW.organization_id
       AND q.id <> NEW.id
       AND q.starts_on <= NEW.ends_on
       AND q.ends_on   >= NEW.starts_on
  ) THEN
    RAISE EXCEPTION 'An accounting period already covers % to % for this workspace',
      NEW.starts_on, NEW.ends_on USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_guard_period_overlap_ins ON public.accounting_periods;
CREATE TRIGGER neo_guard_period_overlap_ins
BEFORE INSERT ON public.accounting_periods
FOR EACH ROW EXECUTE FUNCTION public.neo_guard_period_overlap();

DROP TRIGGER IF EXISTS neo_guard_period_overlap_upd ON public.accounting_periods;
CREATE TRIGGER neo_guard_period_overlap_upd
BEFORE UPDATE OF starts_on, ends_on ON public.accounting_periods
FOR EACH ROW
WHEN (OLD.starts_on IS DISTINCT FROM NEW.starts_on OR OLD.ends_on IS DISTINCT FROM NEW.ends_on)
EXECUTE FUNCTION public.neo_guard_period_overlap();