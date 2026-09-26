-- 1. audit_trail(): SECURITY DEFINER function must not be callable anonymously.
REVOKE ALL ON FUNCTION public.audit_trail(timestamp with time zone, timestamp with time zone, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_trail(timestamp with time zone, timestamp with time zone, text, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.audit_trail(timestamp with time zone, timestamp with time zone, text, uuid, integer) TO authenticated;

-- 2. customers: replace blanket staff read with permission-scoped read.
DROP POLICY IF EXISTS "staff read customers" ON public.customers;
CREATE POLICY "staff read customers"
  ON public.customers FOR SELECT TO authenticated
  USING (
    public.is_staff()
    AND organization_id = public.current_org_id()
    AND (
      public.is_org_admin()
      OR public.has_permission('marketing', 'customers', 'view')
      OR public.has_permission('front-office', '*', 'view')
      OR public.has_permission('events', '*', 'view')
      OR public.has_permission('restaurant', '*', 'view')
      OR public.has_permission('delivery', '*', 'view')
      OR public.has_permission('finance', '*', 'view')
    )
  );

-- 3. delivery_order_pins: explicit, organisation-scoped write path for delivery staff.
DROP POLICY IF EXISTS "delivery_order_pins_staff_insert" ON public.delivery_order_pins;
CREATE POLICY "delivery_order_pins_staff_insert"
  ON public.delivery_order_pins FOR INSERT TO authenticated
  WITH CHECK (
    public.is_staff()
    AND organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('delivery', '*', 'create'))
  );

DROP POLICY IF EXISTS "delivery_order_pins_staff_consume" ON public.delivery_order_pins;
CREATE POLICY "delivery_order_pins_staff_consume"
  ON public.delivery_order_pins FOR UPDATE TO authenticated
  USING (
    public.is_staff()
    AND organization_id = public.current_org_id()
    AND (public.is_org_admin() OR public.has_permission('delivery', '*', 'edit'))
  )
  WITH CHECK (
    public.is_staff()
    AND organization_id = public.current_org_id()
  );

-- 4. event_documents: a client may only read a shared document tied to their own booking or enquiry.
DROP POLICY IF EXISTS "event_documents owner read" ON public.event_documents;
CREATE POLICY "event_documents owner read"
  ON public.event_documents FOR SELECT TO authenticated
  USING (
    visible_to_client
    AND customer_id IS NOT NULL
    AND customer_id = public.my_customer_id()
    AND (
      EXISTS (
        SELECT 1 FROM public.event_bookings b
        WHERE b.id = event_documents.booking_id
          AND b.customer_id = event_documents.customer_id
          AND b.organization_id = event_documents.organization_id
      )
      OR EXISTS (
        SELECT 1 FROM public.event_enquiries e
        WHERE e.id = event_documents.enquiry_id
          AND e.customer_id = event_documents.customer_id
          AND e.organization_id = event_documents.organization_id
      )
    )
  );