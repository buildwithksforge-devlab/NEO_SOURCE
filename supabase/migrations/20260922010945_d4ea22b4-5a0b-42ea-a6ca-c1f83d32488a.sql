-- 1) Audit trail: the system writes it, never a client session.
DROP POLICY IF EXISTS "audit insert" ON public.audit_logs;
CREATE POLICY "audit trail is written by the system only"
  ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (false);

REVOKE INSERT, UPDATE, DELETE ON public.audit_logs FROM authenticated;
REVOKE ALL ON public.audit_logs FROM anon;
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;

DO $$
DECLARE part regclass;
BEGIN
  FOR part IN
    SELECT c.oid::regclass
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.audit_logs'::regclass
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %s FROM authenticated', part);
    EXECUTE format('REVOKE ALL ON %s FROM anon', part);
    EXECUTE format('GRANT SELECT ON %s TO authenticated', part);
    EXECUTE format('GRANT ALL ON %s TO service_role', part);
  END LOOP;
END $$;

-- 2) Delivery handover secrets: never readable from a client session. The
-- controlled reveal routine (neo_delivery_pin_reveal) remains the only path.
DROP POLICY IF EXISTS "delivery_order_pins_no_client_read" ON public.delivery_order_pins;
CREATE POLICY "delivery_order_pins_no_client_read"
  ON public.delivery_order_pins FOR SELECT TO authenticated
  USING (false);

REVOKE SELECT ON public.delivery_order_pins FROM authenticated;
REVOKE ALL ON public.delivery_order_pins FROM anon;
GRANT INSERT, UPDATE ON public.delivery_order_pins TO authenticated;
GRANT ALL ON public.delivery_order_pins TO service_role;

-- 3) M-Pesa callbacks carry payer telephone numbers, references and amounts:
-- finance sight, not workspace-wide sight.
DROP POLICY IF EXISTS "mpesa callback events readable in org" ON public.mpesa_callback_events;
CREATE POLICY "Finance members read mpesa callback events"
  ON public.mpesa_callback_events FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      is_org_admin_for(organization_id)
      OR has_permission('finance'::text, 'payments'::text, 'view'::text)
      OR has_permission('finance'::text, 'view'::text)
    )
  );

REVOKE ALL ON public.mpesa_callback_events FROM anon;
GRANT SELECT ON public.mpesa_callback_events TO authenticated;
GRANT ALL ON public.mpesa_callback_events TO service_role;