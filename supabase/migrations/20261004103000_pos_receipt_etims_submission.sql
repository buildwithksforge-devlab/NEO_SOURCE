-- POS receipts are fiscal sales documents in their own right.
-- They must not create synthetic invoices or duplicate Finance postings.

ALTER TABLE public.etims_submissions
  ADD COLUMN IF NOT EXISTS pos_order_id uuid
  REFERENCES public.pos_orders(id);

ALTER TABLE public.etims_submissions
  DROP CONSTRAINT IF EXISTS etims_submissions_document_kind_check;

ALTER TABLE public.etims_submissions
  ADD CONSTRAINT etims_submissions_document_kind_check
  CHECK (
    document_kind IN (
      'invoice',
      'credit_note',
      'debit_note',
      'pos_receipt'
    )
  );

DROP FUNCTION IF EXISTS public.neo_etims_queue_document(uuid, uuid);

CREATE OR REPLACE FUNCTION public.neo_etims_queue_document(
  _invoice uuid DEFAULT NULL,
  _credit_note uuid DEFAULT NULL,
  _pos_order uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _inv public.invoices%ROWTYPE;
  _cn public.credit_notes%ROWTYPE;
  _pos public.pos_orders%ROWTYPE;
  _branch uuid;
  _kind text;
  _number text;
  _key text;
  _id uuid;
  _enabled boolean;
  _source_count integer;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object(
      'queued', false,
      'reason', 'No organisation is linked to this account.'
    );
  END IF;

  IF _pos_order IS NOT NULL THEN
    IF NOT (
      public.has_permission('pos', 'receipts', 'print')
      OR public.is_org_admin()
    ) THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'You do not have permission to fiscalise POS receipts.'
      );
    END IF;
  ELSE
    IF NOT (
      public.has_permission('finance', 'edit')
      OR public.is_org_admin()
    ) THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'You do not have permission to file tax documents.'
      );
    END IF;
  END IF;

  SELECT COALESCE(enabled, false)
    INTO _enabled
  FROM public.etims_settings
  WHERE organization_id = _org;

  IF NOT COALESCE(_enabled, false) THEN
    RETURN jsonb_build_object(
      'queued', false,
      'reason', 'eTIMS is not configured and enabled for this organisation.'
    );
  END IF;

  _source_count :=
      CASE WHEN _invoice IS NOT NULL THEN 1 ELSE 0 END
    + CASE WHEN _credit_note IS NOT NULL THEN 1 ELSE 0 END
    + CASE WHEN _pos_order IS NOT NULL THEN 1 ELSE 0 END;

  IF _source_count <> 1 THEN
    RETURN jsonb_build_object(
      'queued', false,
      'reason', 'Exactly one fiscal document source is required.'
    );
  END IF;

  IF _pos_order IS NOT NULL THEN
    SELECT *
      INTO _pos
    FROM public.pos_orders
    WHERE id = _pos_order
      AND organization_id = _org;

    IF _pos.id IS NULL THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'POS order not found.'
      );
    END IF;

    IF NOT public.neo_branch_in_scope(_pos.branch_id) THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'That POS order is outside your property access scope.'
      );
    END IF;

    -- Room-charge POS revenue follows the folio lifecycle and must not be
    -- fiscalised here as a second independent sale.
    IF _pos.folio_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'Room-charge orders are fiscalised through their guest billing document.'
      );
    END IF;

    IF _pos.status NOT IN ('closed', 'paid', 'settled', 'completed') THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'Only completed POS sales can be filed.'
      );
    END IF;

    IF COALESCE(_pos.payment_status, '') <> 'paid'
       AND COALESCE(_pos.paid_total, 0) < COALESCE(_pos.grand_total, 0) THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'The POS sale must be fully paid before fiscalisation.'
      );
    END IF;

    _branch := _pos.branch_id;
    _kind := 'pos_receipt';
    _number := _pos.order_number;

  ELSIF _credit_note IS NOT NULL THEN
    SELECT *
      INTO _cn
    FROM public.credit_notes
    WHERE id = _credit_note
      AND organization_id = _org;

    IF _cn.id IS NULL THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'Credit note not found.'
      );
    END IF;

    _branch := _cn.branch_id;
    _kind := 'credit_note';
    _number := _cn.note_number;

  ELSE
    SELECT *
      INTO _inv
    FROM public.invoices
    WHERE id = _invoice
      AND organization_id = _org;

    IF _inv.id IS NULL THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'Invoice not found.'
      );
    END IF;

    IF _inv.status = 'draft' THEN
      RETURN jsonb_build_object(
        'queued', false,
        'reason', 'Only issued invoices can be filed.'
      );
    END IF;

    _branch := _inv.branch_id;
    _kind := 'invoice';
    _number := _inv.invoice_number;
  END IF;

  _key := _kind || ':' || _number;

  INSERT INTO public.etims_submissions (
    organization_id,
    branch_id,
    document_kind,
    invoice_id,
    credit_note_id,
    pos_order_id,
    document_number,
    idempotency_key,
    status,
    created_by
  )
  VALUES (
    _org,
    _branch,
    _kind,
    _invoice,
    _credit_note,
    _pos_order,
    _number,
    _key,
    'queued',
    auth.uid()
  )
  ON CONFLICT (organization_id, idempotency_key)
  DO UPDATE SET
    status = CASE
      WHEN public.etims_submissions.status IN ('accepted', 'submitted')
        THEN public.etims_submissions.status
      ELSE 'queued'
    END,
    updated_at = now()
  RETURNING id INTO _id;

  IF _invoice IS NOT NULL THEN
    UPDATE public.invoices
       SET etims_status = 'queued'
     WHERE id = _invoice
       AND etims_status <> 'accepted';
  END IF;

  RETURN jsonb_build_object(
    'queued', true,
    'submission', _id,
    'document_number', _number,
    'kind', _kind
  );
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_etims_queue_document(uuid, uuid, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_etims_queue_document(uuid, uuid, uuid)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_pos_etims_status(_pos_order uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _order public.pos_orders%ROWTYPE;
  _submission public.etims_submissions%ROWTYPE;
BEGIN
  IF _org IS NULL THEN
    RETURN jsonb_build_object('found', false, 'status', 'not_filed');
  END IF;

  IF NOT (
    public.has_permission('pos', 'receipts', 'print')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view POS fiscal status.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO _order
  FROM public.pos_orders
  WHERE id = _pos_order
    AND organization_id = _org;

  IF _order.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'status', 'not_found');
  END IF;

  IF NOT public.neo_branch_in_scope(_order.branch_id) THEN
    RAISE EXCEPTION 'That POS order is outside your property access scope.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO _submission
  FROM public.etims_submissions
  WHERE organization_id = _org
    AND pos_order_id = _order.id
  ORDER BY updated_at DESC, created_at DESC
  LIMIT 1;

  IF _submission.id IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'status', 'not_filed'
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'found', true,
      'submission_id', _submission.id,
      'status', _submission.status,
      'kra_reference', _submission.kra_reference,
      'control_unit_reference', _submission.control_unit_reference,
      'error_details', _submission.error_details
    )
  );
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_pos_etims_status(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_pos_etims_status(uuid)
TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';