CREATE OR REPLACE FUNCTION public.neo_event_status_normalise(_status text, _fallback text DEFAULT 'provisional-hold')
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(nullif(btrim(_status), ''), _fallback))
    WHEN 'tentative' THEN 'provisional-hold'
    WHEN 'hold' THEN 'provisional-hold'
    WHEN 'provisional' THEN 'provisional-hold'
    WHEN 'planning' THEN 'in-planning'
    WHEN 'definite' THEN 'confirmed'
    ELSE lower(coalesce(nullif(btrim(_status), ''), _fallback))
  END
$$;

CREATE OR REPLACE FUNCTION public.neo_event_payment_status_normalise(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(nullif(btrim(_status), ''), 'unpaid'))
    WHEN 'partial' THEN 'partially-paid'
    WHEN 'part-paid' THEN 'partially-paid'
    ELSE lower(coalesce(nullif(btrim(_status), ''), 'unpaid'))
  END
$$;

REVOKE EXECUTE ON FUNCTION public.neo_event_status_normalise(text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_event_payment_status_normalise(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_status_normalise(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_payment_status_normalise(text) TO authenticated;