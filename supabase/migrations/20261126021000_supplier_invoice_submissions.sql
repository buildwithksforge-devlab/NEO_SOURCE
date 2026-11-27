BEGIN;

CREATE TABLE public.neo_supplier_invoice_submissions (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    supplier_id uuid NOT NULL
      REFERENCES public.suppliers(id),

    purchase_order_id uuid NOT NULL
      REFERENCES public.purchase_orders(id),

    invoice_number text NOT NULL,

    invoice_date date NOT NULL,

    currency text NOT NULL
      CHECK (currency ~ '^[A-Z]{3}$'),

    declared_amount numeric(18,2) NOT NULL
      CHECK (
        declared_amount > 0
        AND declared_amount::text NOT IN (
          'NaN','Infinity','-Infinity'
        )
      ),

    delivery_reference text,

    notes text,

    submitted_by uuid NOT NULL,

    submitted_at timestamptz NOT NULL DEFAULT now(),

    attempt_key uuid NOT NULL,

    UNIQUE (organization_id,attempt_key),

    CHECK (
      length(btrim(invoice_number))
      BETWEEN 1 AND 120
    ),

    CHECK (
      length(coalesce(notes,'')) <= 4000
    ),

    CHECK (
      length(coalesce(delivery_reference,'')) <= 200
    )

);

CREATE UNIQUE INDEX neo_supplier_invoice_submission_reference

ON public.neo_supplier_invoice_submissions (

    organization_id,

    supplier_id,

    lower(btrim(invoice_number))

);

CREATE INDEX neo_supplier_invoice_submission_lookup

ON public.neo_supplier_invoice_submissions (

    organization_id,

    branch_id,

    supplier_id,

    submitted_at DESC

);

ALTER TABLE public.neo_supplier_invoice_submissions
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.neo_supplier_invoice_submissions
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 2. SUPPLIER INVOICE SUBMISSION TRANSACTION
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_invoice_submit(

    _branch uuid,

    _relationship uuid,

    _order_number text,

    _invoice_number text,

    _invoice_date date,

    _amount numeric,

    _delivery_reference text,

    _notes text,

    _attempt uuid

)
RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    order_id uuid;

    p public.purchase_orders%ROWTYPE;

    prior public.neo_supplier_invoice_submissions%ROWTYPE;

    result_id uuid;

    invoice_ref text;

    delivery_ref text;

    note_text text;

    currency_code text;

BEGIN

    order_id := public.neo_supplier_lpo_response_scope(
      _branch,
      _relationship,
      _order_number
    );

    invoice_ref := btrim(coalesce(_invoice_number,''));

    delivery_ref := nullif(
      btrim(coalesce(_delivery_reference,'')),
      ''
    );

    note_text := nullif(
      btrim(coalesce(_notes,'')),
      ''
    );

    IF _attempt IS NULL

      OR length(invoice_ref) NOT BETWEEN 1 AND 120

      OR _invoice_date IS NULL

      OR _amount IS NULL

      OR _amount <= 0

      OR _amount::text IN (
        'NaN','Infinity','-Infinity'
      )

      OR _amount <> round(_amount,2)

      OR _amount >= 10000000000000000

      OR length(coalesce(delivery_ref,'')) > 200

      OR length(coalesce(note_text,'')) > 4000

    THEN

      RAISE EXCEPTION 'Invalid supplier invoice submission'
        USING ERRCODE='22023';

    END IF;

    SELECT *

    INTO p

    FROM public.purchase_orders o

    WHERE o.id = order_id

      AND o.branch_id = _branch

    FOR UPDATE;

    IF p.id IS NULL

      OR public.neo_supplier_lpo_response_scope(

        _branch,

        _relationship,

        _order_number

      ) IS DISTINCT FROM p.id

    THEN

      RAISE EXCEPTION 'Purchase order unavailable'
        USING ERRCODE='42501';

    END IF;

    currency_code := upper(
      coalesce(
        nullif(to_jsonb(p)->>'currency',''),
        public.neo_fact_currency(
          p.organization_id,p.branch_id
        )
      )
    );

    IF currency_code !~ '^[A-Z]{3}$' THEN

      RAISE EXCEPTION 'Purchase order currency unavailable';

    END IF;

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        p.organization_id::text ||

        ':supplier-invoice:' ||

        _attempt::text,

        0

      )

    );

    SELECT *

    INTO prior

    FROM public.neo_supplier_invoice_submissions s

    WHERE s.organization_id = p.organization_id

      AND s.attempt_key = _attempt;

    IF prior.id IS NOT NULL THEN

      IF prior.purchase_order_id IS DISTINCT FROM p.id

        OR prior.branch_id IS DISTINCT FROM p.branch_id

        OR prior.supplier_id IS DISTINCT FROM p.supplier_id

        OR prior.submitted_by IS DISTINCT FROM auth.uid()

        OR prior.invoice_number IS DISTINCT FROM invoice_ref

        OR prior.invoice_date IS DISTINCT FROM _invoice_date

        OR prior.declared_amount IS DISTINCT FROM _amount

        OR prior.currency IS DISTINCT FROM currency_code

        OR prior.delivery_reference IS DISTINCT FROM delivery_ref

        OR prior.notes IS DISTINCT FROM note_text

      THEN

        RAISE EXCEPTION 'Invoice retry payload mismatch'
          USING ERRCODE='22023';

      END IF;

      RETURN jsonb_build_object(

        'ok',true,

        'submission_id',prior.id,

        'duplicate_prevented',true

      );

    END IF;

    IF p.status NOT IN (

      'approved',

      'issued',

      'sent',

      'ordered',

      'partially-received',

      'received',

      'partially-invoiced',

      'fully-invoiced',

      'completed',

      'closed'

    ) THEN

      RAISE EXCEPTION 'Purchase order does not accept invoices';

    END IF;

    IF _invoice_date > CURRENT_DATE THEN

      RAISE EXCEPTION 'Invoice date cannot be in the future';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.suppliers s

      WHERE s.id = p.supplier_id

        AND s.organization_id = p.organization_id

        AND s.active IS TRUE

        AND public.neo_record_operationally_enabled(
          to_jsonb(s)
        ) IS TRUE

    ) THEN

      RAISE EXCEPTION 'Supplier unavailable';

    END IF;

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        p.organization_id::text ||

        ':supplier-invoice-number:' ||

        p.supplier_id::text ||

        ':' ||

        lower(invoice_ref),

        0

      )

    );

    IF EXISTS (

      SELECT 1

      FROM public.neo_supplier_invoice_submissions s

      WHERE s.organization_id = p.organization_id

        AND s.supplier_id = p.supplier_id

        AND lower(btrim(s.invoice_number)) =
          lower(invoice_ref)

    ) THEN

      RAISE EXCEPTION 'Invoice number already submitted';

    END IF;

    INSERT INTO public.neo_supplier_invoice_submissions (

      organization_id,

      branch_id,

      supplier_id,

      purchase_order_id,

      invoice_number,

      invoice_date,

      currency,

      declared_amount,

      delivery_reference,

      notes,

      submitted_by,

      attempt_key

    )

    VALUES (

      p.organization_id,

      p.branch_id,

      p.supplier_id,

      p.id,

      invoice_ref,

      _invoice_date,

      currency_code,

      _amount,

      delivery_ref,

      note_text,

      auth.uid(),

      _attempt

    )

    RETURNING id INTO result_id;

    RETURN jsonb_build_object(

      'ok',true,

      'submission_id',result_id,

      'review_required',true,

      'payable_created',false

    );

END;

$function$;


-- ==========================================
-- 3. SUPPLIER OWN SUBMISSION HISTORY
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_invoice_submissions(

    _branch uuid,

    _relationship uuid

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    rel public.neo_access_relationships%ROWTYPE;

BEGIN

    IF auth.uid() IS NULL
      OR _branch IS NULL
    THEN

      RAISE EXCEPTION 'Authentication required'
        USING ERRCODE='42501';

    END IF;

    SELECT *

    INTO rel

    FROM public.neo_access_relationships r

    WHERE r.id = _relationship

      AND r.auth_user_id = auth.uid()

      AND r.door = 'partner'

      AND r.status = 'active'

      AND r.supplier_id IS NOT NULL

      AND (
        r.branch_id IS NULL
        OR r.branch_id = _branch
      );

    IF rel.id IS NULL

      OR NOT EXISTS (

        SELECT 1

        FROM public.branches b

        WHERE b.id = _branch

          AND b.organization_id = rel.organization_id

          AND b.active IS TRUE

      )

    THEN

      RAISE EXCEPTION 'Supplier access denied'
        USING ERRCODE='42501';

    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(
        to_jsonb(x)
        ORDER BY x.submitted_at DESC,x.id DESC
      )

      FROM (

        SELECT

          s.id,

          p.order_number,

          s.invoice_number,

          s.invoice_date,

          s.currency,

          s.declared_amount,

          s.delivery_reference,

          s.notes,

          s.submitted_at,

          'submitted'::text AS submission_status

        FROM public.neo_supplier_invoice_submissions s

        JOIN public.purchase_orders p

          ON p.id = s.purchase_order_id

          AND p.organization_id = s.organization_id

          AND p.branch_id = s.branch_id

          AND p.supplier_id = s.supplier_id

        WHERE s.organization_id = rel.organization_id

          AND s.branch_id = _branch

          AND s.supplier_id = rel.supplier_id

        ORDER BY s.submitted_at DESC,s.id DESC

        LIMIT 200

      ) x

    ),'[]'::jsonb);

END;

$function$;


-- ==========================================
-- 4. INTERNAL SUPPLIER SUBMISSION REGISTER
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_invoice_submission_register(

    _branch uuid DEFAULT NULL

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

BEGIN

    IF auth.uid() IS NULL

      OR org IS NULL

      OR public.current_access_scope() IS NULL

      OR public.current_access_scope() = 'technical'

      OR NOT coalesce(

        public.has_permission('finance','view')

        OR public.has_permission(
          'procurement','quotations.manage'
        )

        OR public.has_permission(
          'procurement','orders.create'
        )

        OR public.is_org_admin(),

        false

      )

    THEN

      RAISE EXCEPTION 'Invoice register access denied'
        USING ERRCODE='42501';

    END IF;

    IF _branch IS NOT NULL

      AND public.neo_branch_in_scope(_branch) IS NOT TRUE

    THEN

      RAISE EXCEPTION 'Property access denied'
        USING ERRCODE='42501';

    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(
        to_jsonb(x)
        ORDER BY x.submitted_at DESC,x.id DESC
      )

      FROM (

        SELECT

          i.id,

          i.branch_id,

          i.supplier_id,

          s.name AS supplier_name,

          i.purchase_order_id,

          p.order_number,

          i.invoice_number,

          i.invoice_date,

          i.currency,

          i.declared_amount,

          i.delivery_reference,

          i.notes,

          i.submitted_at

        FROM public.neo_supplier_invoice_submissions i

        JOIN public.suppliers s

          ON s.id = i.supplier_id

          AND s.organization_id = i.organization_id

        JOIN public.purchase_orders p

          ON p.id = i.purchase_order_id

          AND p.organization_id = i.organization_id

          AND p.branch_id = i.branch_id

          AND p.supplier_id = i.supplier_id

        WHERE i.organization_id = org

          AND (
            _branch IS NULL
            OR i.branch_id = _branch
          )

          AND public.neo_branch_in_scope(
            i.branch_id
          ) IS TRUE

        ORDER BY i.submitted_at DESC,i.id DESC

        LIMIT 300

      ) x

    ),'[]'::jsonb);

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_partner_supplier_invoice_submit(
  uuid,uuid,text,text,date,numeric,text,text,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_invoice_submit(
  uuid,uuid,text,text,date,numeric,text,text,uuid
)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_partner_supplier_invoice_submissions(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_invoice_submissions(uuid,uuid)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_supplier_invoice_submission_register(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_supplier_invoice_submission_register(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;