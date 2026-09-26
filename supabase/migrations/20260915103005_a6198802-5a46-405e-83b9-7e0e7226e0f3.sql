CREATE OR REPLACE FUNCTION public.neo_approval_normalize_status(_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(_status,'pending_approval'))
    WHEN 'pending' THEN 'pending'
    WHEN 'pending_approval' THEN 'pending'
    WHEN 'approved' THEN 'approved'
    WHEN 'approved_pending_execution' THEN 'approved'
    WHEN 'executing' THEN 'approved'
    WHEN 'complete' THEN 'completed'
    WHEN 'completed' THEN 'completed'
    WHEN 'declined' THEN 'rejected'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'void' THEN 'cancelled'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'execution_failed' THEN 'execution_failed'
    WHEN 'draft' THEN 'draft'
    ELSE lower(coalesce(_status,'pending_approval'))
  END
$$;

GRANT EXECUTE ON FUNCTION public.neo_approval_normalize_status(text) TO authenticated, anon, service_role;