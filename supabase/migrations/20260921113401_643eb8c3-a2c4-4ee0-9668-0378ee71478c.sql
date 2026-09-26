
CREATE OR REPLACE FUNCTION public.neo_canonical_channel(_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN _raw IS NULL OR btrim(_raw) = '' THEN 'unspecified'
    WHEN lower(_raw) IN ('customer-app','customer_app','guest-app','app','mobile') THEN 'customer_app'
    WHEN lower(_raw) IN ('online','customer-web','customer_web','web','website') THEN 'customer_web'
    WHEN lower(_raw) IN ('waiter-pos','waiter','bar-pos','pos','staff-assisted','staff_assisted','counter') THEN 'staff_taken'
    WHEN lower(_raw) IN ('staff-phone','phone','call','call-centre') THEN 'phone'
    WHEN lower(_raw) IN ('walk-in','walkin','walk_in') THEN 'walk_in'
    WHEN lower(_raw) IN ('room-service','room_service','in-room') THEN 'room_service'
    WHEN lower(_raw) IN ('partner','marketplace','aggregator','ota') THEN 'partner'
    WHEN lower(_raw) IN ('rider','rider-app') THEN 'rider'
    WHEN lower(_raw) IN ('import','imported','migration','uat','test') THEN 'imported'
    ELSE 'other'
  END;
$$;

CREATE OR REPLACE VIEW public.neo_channel_attribution
WITH (security_invoker = true) AS
  SELECT o.organization_id, o.branch_id, 'restaurant'::text AS stream, o.id AS record_id,
         public.neo_canonical_channel(o.order_source) AS channel,
         o.grand_total AS amount, o.created_at
    FROM public.pos_orders o
  UNION ALL
  SELECT d.organization_id, d.branch_id, 'delivery'::text, d.id,
         public.neo_canonical_channel(d.order_channel), d.grand_total, d.created_at
    FROM public.delivery_orders d
  UNION ALL
  SELECT l.organization_id, l.branch_id, 'laundry'::text, l.id,
         public.neo_canonical_channel(l.source_channel), l.total, l.created_at
    FROM public.guest_laundry_orders l;

GRANT SELECT ON public.neo_channel_attribution TO authenticated;

CREATE TABLE IF NOT EXISTS public.neo_external_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid REFERENCES public.branches(id),
  provider text NOT NULL,
  provider_reference text NOT NULL,
  transaction_kind text NOT NULL DEFAULT 'payment',
  channel text NOT NULL DEFAULT 'partner',
  amount numeric(14,2),
  currency text,
  occurred_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received',
  matched_table text,
  matched_record_id uuid,
  duplicate_of uuid REFERENCES public.neo_external_transactions(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neo_external_transactions_status_chk
    CHECK (status IN ('received','matched','duplicate','ignored','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS neo_external_transactions_ref_uq
  ON public.neo_external_transactions (organization_id, lower(provider), lower(provider_reference));

CREATE INDEX IF NOT EXISTS neo_external_transactions_status_idx
  ON public.neo_external_transactions (organization_id, status, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.neo_external_transactions TO authenticated;
GRANT ALL ON public.neo_external_transactions TO service_role;

ALTER TABLE public.neo_external_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neo_external_transactions_read ON public.neo_external_transactions;
CREATE POLICY neo_external_transactions_read
  ON public.neo_external_transactions FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS neo_external_transactions_write ON public.neo_external_transactions;
CREATE POLICY neo_external_transactions_write
  ON public.neo_external_transactions FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
              AND public.is_org_admin_for(organization_id));

DROP POLICY IF EXISTS neo_external_transactions_update ON public.neo_external_transactions;
CREATE POLICY neo_external_transactions_update
  ON public.neo_external_transactions FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
         AND public.is_org_admin_for(organization_id))
  WITH CHECK (organization_id = public.current_org_id()
              AND public.is_org_admin_for(organization_id));

DROP TRIGGER IF EXISTS neo_external_transactions_touch ON public.neo_external_transactions;
CREATE TRIGGER neo_external_transactions_touch
  BEFORE UPDATE ON public.neo_external_transactions
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_external_transaction_record(
  _org uuid,
  _branch uuid,
  _provider text,
  _reference text,
  _kind text DEFAULT 'payment',
  _amount numeric DEFAULT NULL,
  _currency text DEFAULT NULL,
  _occurred_at timestamptz DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _existing uuid;
  _id uuid;
BEGIN
  IF _org IS NULL OR _provider IS NULL OR btrim(COALESCE(_reference, '')) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_reference');
  END IF;
  IF _branch IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'property_not_in_organisation');
  END IF;

  SELECT id INTO _existing
    FROM public.neo_external_transactions
   WHERE organization_id = _org
     AND lower(provider) = lower(_provider)
     AND lower(provider_reference) = lower(btrim(_reference));

  IF _existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', _existing);
  END IF;

  INSERT INTO public.neo_external_transactions (
    organization_id, branch_id, provider, provider_reference, transaction_kind,
    amount, currency, occurred_at, payload
  ) VALUES (
    _org, _branch, _provider, btrim(_reference), COALESCE(_kind, 'payment'),
    _amount, _currency, COALESCE(_occurred_at, now()), COALESCE(_payload, '{}'::jsonb)
  )
  ON CONFLICT (organization_id, lower(provider), lower(provider_reference)) DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NULL THEN
    SELECT id INTO _id FROM public.neo_external_transactions
     WHERE organization_id = _org
       AND lower(provider) = lower(_provider)
       AND lower(provider_reference) = lower(btrim(_reference));
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', _id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', _id);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_external_transaction_record(uuid, uuid, text, text, text, numeric, text, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_external_transaction_record(uuid, uuid, text, text, text, numeric, text, timestamptz, jsonb) TO service_role;
