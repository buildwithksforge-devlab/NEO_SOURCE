-- 1. Delivery PINs: retire the legacy plaintext column contents.
UPDATE public.delivery_order_pins
   SET pin_secret = CASE WHEN coalesce(pin_secret, '') <> '' THEN pin_secret ELSE pin END,
       pin_hash = CASE
                    WHEN coalesce(pin_hash, '') <> '' THEN pin_hash
                    ELSE public.neo_delivery_pin_fingerprint(pin, delivery_order_id)
                  END,
       is_legacy = false,
       pin = '',
       updated_at = now()
 WHERE coalesce(pin, '') <> '';

UPDATE public.delivery_order_pins SET pin = '' WHERE pin <> '';

ALTER TABLE public.delivery_order_pins ALTER COLUMN pin SET DEFAULT '';

ALTER TABLE public.delivery_order_pins
  ADD CONSTRAINT delivery_order_pins_no_plaintext CHECK (pin = '') NOT VALID;
ALTER TABLE public.delivery_order_pins VALIDATE CONSTRAINT delivery_order_pins_no_plaintext;

-- Stop the reveal paths from ever falling back to the retired column.
CREATE OR REPLACE FUNCTION public.neo_delivery_pin_for_customer(_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE p public.delivery_order_pins;
BEGIN
  SELECT * INTO p FROM public.delivery_order_pins WHERE delivery_order_id = _order;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_pin'); END IF;
  IF p.customer_id IS DISTINCT FROM public.my_customer_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_your_order');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'pin', nullif(p.pin_secret, ''),
    'issued_at', p.issued_at,
    'expires_at', p.expires_at,
    'consumed_at', p.consumed_at,
    'invalidated_at', p.invalidated_at,
    'locked', p.locked_at IS NOT NULL,
    'channel', p.last_channel,
    'sent_at', p.last_sent_at,
    'send_status', p.last_send_status
  );
END;
$fn$;

-- 2. Role / access directory visibility: access administration permissions only.
CREATE OR REPLACE FUNCTION public.can_view_role_directory()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT is_org_admin_for(current_org_id())
      OR has_permission('administration', 'roles', 'view')
      OR has_permission('administration', 'roles', 'manage')
      OR has_permission('administration', 'users', 'view_access')
      OR has_permission('administration', 'users', 'assign_roles')
      OR has_permission('administration', 'users', 'assign_role')
      OR has_permission('administration', 'users', 'override_permission')
$fn$;

-- 3. Explicit policies on the role grant migration log partitions.
DO $$
DECLARE part text;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND c.relname LIKE 'role\_grant\_migration\_log\_p%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', part || '_admin_read', part);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = current_org_id() AND is_org_admin_for(organization_id))',
      part || '_admin_read', part);
    -- No INSERT/UPDATE/DELETE policies: writes are intentionally system-only.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated, anon', part);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', part);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', part);
  END LOOP;
END $$;

COMMENT ON TABLE public.role_grant_migration_log IS
  'Role grant migration history. Reads are organisation-scoped; writes are performed by system routines only (no write policies by design).';
