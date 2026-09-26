-- NEØ certification hardening: maintenance must not fail when a stock item has
-- no average cost yet. Preserve the part issue and flag it as unvalued (0).

ALTER TABLE public.work_order_parts
  ALTER COLUMN unit_cost SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.neo_maintenance_part_cost_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public
AS $$
BEGIN
  NEW.unit_cost := COALESCE(NEW.unit_cost,0);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS neo_maintenance_part_cost_default_trg ON public.work_order_parts;
CREATE TRIGGER neo_maintenance_part_cost_default_trg
BEFORE INSERT OR UPDATE OF unit_cost ON public.work_order_parts
FOR EACH ROW EXECUTE FUNCTION public.neo_maintenance_part_cost_default();
