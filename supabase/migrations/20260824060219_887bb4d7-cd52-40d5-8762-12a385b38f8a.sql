CREATE OR REPLACE FUNCTION public.integration_mask_identifier()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v text := btrim(coalesce(NEW.masked_identifier, ''));
BEGIN
  IF v = '' THEN
    NEW.masked_identifier := nullif(v, '');
    RETURN NEW;
  END IF;
  -- Never persist a full credential: keep a recognisable tail only.
  IF v LIKE '%' || chr(8226) || '%' OR length(v) <= 8 THEN
    RETURN NEW;
  END IF;
  NEW.masked_identifier := repeat(chr(8226), 4) || right(v, 4);
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_integration_mask_identifier ON public.integration_connections;
CREATE TRIGGER trg_integration_mask_identifier
  BEFORE INSERT OR UPDATE OF masked_identifier ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.integration_mask_identifier();

UPDATE public.integration_connections
   SET masked_identifier = masked_identifier
 WHERE masked_identifier IS NOT NULL AND length(btrim(masked_identifier)) > 8;