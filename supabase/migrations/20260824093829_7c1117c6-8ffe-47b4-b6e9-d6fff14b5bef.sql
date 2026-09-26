ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS guest_account_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS guest_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_link_method text,
  ADD COLUMN IF NOT EXISTS guest_invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_invited_by uuid,
  ADD COLUMN IF NOT EXISTS last_guest_app_activity_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_guest_account_status_check'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_guest_account_status_check
      CHECK (guest_account_status IN ('none','invited','activated','active','suspended'));
  END IF;
END $$;

UPDATE public.customers
   SET guest_account_status = 'active',
       guest_linked_at = COALESCE(guest_linked_at, created_at),
       guest_link_method = COALESCE(guest_link_method, 'self_registration')
 WHERE auth_user_id IS NOT NULL
   AND guest_account_status = 'none';

CREATE TABLE IF NOT EXISTS public.customer_digital_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  auth_user_id uuid,
  event_type text NOT NULL,
  surface text NOT NULL DEFAULT 'guest_app',
  subject_type text,
  subject_id text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_digital_events_idem_idx
  ON public.customer_digital_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_digital_events_customer_idx
  ON public.customer_digital_events (organization_id, customer_id, occurred_at DESC);

GRANT SELECT ON public.customer_digital_events TO authenticated;
GRANT ALL ON public.customer_digital_events TO service_role;

ALTER TABLE public.customer_digital_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read their own digital activity" ON public.customer_digital_events;
CREATE POLICY "Customers read their own digital activity"
  ON public.customer_digital_events FOR SELECT TO authenticated
  USING (
    customer_id IN (SELECT c.id FROM public.customers c WHERE c.auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Staff read digital activity in their organisation" ON public.customer_digital_events;
CREATE POLICY "Staff read digital activity in their organisation"
  ON public.customer_digital_events FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.neo_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS customer_digital_events_touch ON public.customer_digital_events;
CREATE TRIGGER customer_digital_events_touch
  BEFORE UPDATE ON public.customer_digital_events
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

-- Staff action: invite a customer to the NEO Guest app (no CRM duplication).
CREATE OR REPLACE FUNCTION public.neo_customer_invite_guest(_customer uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.customers;
BEGIN
  SELECT * INTO c FROM public.customers WHERE id = _customer;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF c.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Customer belongs to another organisation';
  END IF;
  IF NOT (public.has_exact_permission('marketing','crm-customers','edit')
          OR public.has_exact_permission('marketing','customers','edit')) THEN
    RAISE EXCEPTION 'Missing permission: marketing.crm-customers.edit';
  END IF;
  IF c.email IS NULL OR btrim(c.email) = '' THEN
    RAISE EXCEPTION 'A verified email address is required before inviting this customer';
  END IF;
  IF c.auth_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('customer_id', c.id, 'status', c.guest_account_status, 'already_linked', true);
  END IF;

  UPDATE public.customers
     SET guest_account_status = 'invited',
         guest_invited_at = now(),
         guest_invited_by = auth.uid(),
         updated_at = now()
   WHERE id = c.id;

  PERFORM public.log_audit_event(
    'crm.customer.guest_invite', 'marketing', c.id::text,
    jsonb_build_object('guest_account_status', c.guest_account_status),
    jsonb_build_object('guest_account_status', 'invited', 'email', c.email),
    _reason, 'marketing.crm-customers.edit', c.primary_branch_id, NULL, NULL, NULL, NULL, NULL);

  RETURN jsonb_build_object('customer_id', c.id, 'status', 'invited', 'already_linked', false);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_customer_invite_guest(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_customer_invite_guest(uuid, text) TO authenticated;

-- Guest action: claim an invitation that matches the signed-in verified email.
CREATE OR REPLACE FUNCTION public.neo_guest_claim_invitation(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  uemail text;
  target public.customers;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT lower(btrim(u.email)) INTO uemail FROM auth.users u WHERE u.id = uid;
  IF uemail IS NULL OR uemail = '' THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'no_email');
  END IF;

  SELECT * INTO target FROM public.customers c
   WHERE c.organization_id = _org
     AND c.auth_user_id IS NULL
     AND c.merged_into_id IS NULL
     AND c.archived_at IS NULL
     AND lower(btrim(c.email)) = uemail
     AND c.guest_account_status = 'invited'
   ORDER BY c.created_at
   LIMIT 1;

  IF target.id IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'no_invitation');
  END IF;

  UPDATE public.customers
     SET auth_user_id = uid,
         guest_account_status = 'active',
         guest_linked_at = now(),
         guest_link_method = 'invitation_email_match',
         last_guest_app_activity_at = now(),
         updated_at = now()
   WHERE id = target.id;

  RETURN jsonb_build_object('linked', true, 'customer_id', target.id);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_claim_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_claim_invitation(uuid) TO authenticated;

-- Guest-app activity recording, owner scoped and idempotent.
CREATE OR REPLACE FUNCTION public.neo_guest_record_event(
  _org uuid,
  _event_type text,
  _subject_type text DEFAULT NULL,
  _subject_id text DEFAULT NULL,
  _properties jsonb DEFAULT '{}'::jsonb,
  _idempotency_key text DEFAULT NULL,
  _surface text DEFAULT 'guest_app'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  c public.customers;
  new_id uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _event_type IS NULL OR btrim(_event_type) = '' THEN
    RAISE EXCEPTION 'Event type is required';
  END IF;

  SELECT * INTO c FROM public.customers
   WHERE organization_id = _org AND auth_user_id = uid AND merged_into_id IS NULL
   LIMIT 1;
  IF c.id IS NULL THEN
    RETURN NULL; -- no customer record in this tenant: record nothing
  END IF;

  INSERT INTO public.customer_digital_events (
    organization_id, branch_id, customer_id, auth_user_id, event_type,
    surface, subject_type, subject_id, properties, idempotency_key)
  VALUES (
    _org, c.primary_branch_id, c.id, uid, _event_type,
    COALESCE(_surface,'guest_app'), _subject_type, _subject_id,
    COALESCE(_properties, '{}'::jsonb), _idempotency_key)
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO new_id;

  UPDATE public.customers
     SET last_guest_app_activity_at = now()
   WHERE id = c.id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_record_event(uuid, text, text, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_record_event(uuid, text, text, text, jsonb, text, text) TO authenticated;