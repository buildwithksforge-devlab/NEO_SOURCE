BEGIN;

CREATE TABLE public.neo_supplier_lpo_acknowledgements (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    purchase_order_id uuid NOT NULL
      REFERENCES public.purchase_orders(id),

    supplier_id uuid NOT NULL
      REFERENCES public.suppliers(id),

    submitted_by uuid NOT NULL,

    response_type text NOT NULL
      CHECK (
        response_type IN (
          'accepted',
          'declined',
          'changes-requested'
        )
      ),

    promised_delivery_date date,

    notes text,

    attempt_key uuid NOT NULL,

    submitted_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (organization_id,attempt_key),

    CHECK (

      response_type <> 'accepted'

      OR promised_delivery_date IS NOT NULL

    ),

    CHECK (

      response_type = 'accepted'

      OR length(btrim(coalesce(notes,''))) >= 5

    ),

    CHECK (
      length(coalesce(notes,'')) <= 4000
    )

);

CREATE INDEX neo_supplier_lpo_acknowledgement_lookup

ON public.neo_supplier_lpo_acknowledgements (

    organization_id,

    branch_id,

    purchase_order_id,

    supplier_id,

    submitted_at DESC

);

ALTER TABLE public.neo_supplier_lpo_acknowledgements
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.neo_supplier_lpo_acknowledgements
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 2. SUPPLIER PURCHASE ORDER ACCESS
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_lpo_response_scope(

    _branch uuid,

    _relationship uuid,

    _number text

)
RETURNS uuid

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    rel public.neo_access_relationships%ROWTYPE;

    order_id uuid;

BEGIN

    IF auth.uid() IS NULL

      OR _branch IS NULL

      OR _relationship IS NULL

      OR length(btrim(coalesce(_number,''))) = 0

    THEN

      RAISE EXCEPTION 'Supplier authentication required'
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

    IF rel.id IS NULL THEN

      RAISE EXCEPTION 'Supplier relationship unavailable'
        USING ERRCODE='42501';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.branches b

      WHERE b.id = _branch

        AND b.organization_id = rel.organization_id

        AND b.active IS TRUE

    ) THEN

      RAISE EXCEPTION 'Property unavailable'
        USING ERRCODE='42501';

    END IF;

    SELECT p.id

    INTO STRICT order_id

    FROM public.purchase_orders p

    WHERE p.organization_id = rel.organization_id

      AND p.branch_id = _branch

      AND p.supplier_id = rel.supplier_id

      AND p.order_number = btrim(_number)

      AND p.status NOT IN (

        'draft',

        'pending',

        'pending-approval',

        'rejected'

      );

    RETURN order_id;

EXCEPTION

    WHEN no_data_found OR too_many_rows THEN

      RAISE EXCEPTION 'Purchase order unavailable'
        USING ERRCODE='42501';

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_lpo_response_scope(uuid,uuid,text)
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 3. SUPPLIER ACKNOWLEDGEMENT TRANSACTION
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_lpo_respond(

    _branch uuid,

    _relationship uuid,

    _number text,

    _response text,

    _delivery_date date,

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

    prior public.neo_supplier_lpo_acknowledgements%ROWTYPE;

    response_id uuid;

    note_text text;

BEGIN

    order_id := public.neo_supplier_lpo_response_scope(

      _branch,

      _relationship,

      _number

    );

    IF _attempt IS NULL

      OR _response IS NULL

      OR _response NOT IN (

        'accepted',

        'declined',

        'changes-requested'

      )

    THEN

      RAISE EXCEPTION 'Invalid supplier response'
        USING ERRCODE='22023';

    END IF;

    note_text := nullif(
      btrim(coalesce(_notes,'')),
      ''
    );

    IF length(coalesce(note_text,'')) > 4000 THEN

      RAISE EXCEPTION 'Response notes are too long';

    END IF;

    IF _response = 'accepted'

      AND _delivery_date IS NULL

    THEN

      RAISE EXCEPTION 'Expected delivery date is required';

    END IF;

    IF _response <> 'accepted'

      AND length(coalesce(note_text,'')) < 5

    THEN

      RAISE EXCEPTION 'Provide a reason for the supplier response';

    END IF;

    SELECT *

    INTO p

    FROM public.purchase_orders o

    WHERE o.id = order_id

      AND o.branch_id = _branch

    FOR UPDATE;

    IF p.id IS NULL THEN

      RAISE EXCEPTION 'Purchase order unavailable';

    END IF;

    -- Recheck the relationship after locking the order.

    IF public.neo_supplier_lpo_response_scope(

      _branch,

      _relationship,

      _number

    ) IS DISTINCT FROM p.id THEN

      RAISE EXCEPTION 'Purchase order scope changed'
        USING ERRCODE='42501';

    END IF;

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        p.organization_id::text ||

        ':supplier-lpo-response:' ||

        _attempt::text,

        0

      )

    );

    SELECT *

    INTO prior

    FROM public.neo_supplier_lpo_acknowledgements a

    WHERE a.organization_id = p.organization_id

      AND a.attempt_key = _attempt;

    IF prior.id IS NOT NULL THEN

      IF prior.purchase_order_id IS DISTINCT FROM p.id

        OR prior.branch_id IS DISTINCT FROM p.branch_id

        OR prior.supplier_id IS DISTINCT FROM p.supplier_id

        OR prior.submitted_by IS DISTINCT FROM auth.uid()

        OR prior.response_type IS DISTINCT FROM _response

        OR prior.promised_delivery_date IS DISTINCT FROM _delivery_date

        OR prior.notes IS DISTINCT FROM note_text

      THEN

        RAISE EXCEPTION 'LPO response retry payload mismatch'
          USING ERRCODE='22023';

      END IF;

      RETURN jsonb_build_object(

        'ok',true,

        'response_id',prior.id,

        'duplicate_prevented',true

      );

    END IF;

    IF p.status NOT IN (

      'approved',

      'issued',

      'sent',

      'ordered',

      'partially-received'

    ) THEN

      RAISE EXCEPTION 'Purchase order is not accepting supplier responses';

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

      RAISE EXCEPTION 'Supplier is not operationally available';

    END IF;

    IF _delivery_date IS NOT NULL

      AND (

        _delivery_date < CURRENT_DATE

        OR _delivery_date > CURRENT_DATE + 730

      )

    THEN

      RAISE EXCEPTION 'Invalid promised delivery date';

    END IF;

    IF p.status = 'partially-received'

      AND _response = 'declined'

    THEN

      RAISE EXCEPTION 'Partially received orders require a change request';

    END IF;

    INSERT INTO public.neo_supplier_lpo_acknowledgements (

      organization_id,

      branch_id,

      purchase_order_id,

      supplier_id,

      submitted_by,

      response_type,

      promised_delivery_date,

      notes,

      attempt_key

    )

    VALUES (

      p.organization_id,

      p.branch_id,

      p.id,

      p.supplier_id,

      auth.uid(),

      _response,

      _delivery_date,

      note_text,

      _attempt

    )

    RETURNING id INTO response_id;

    RETURN jsonb_build_object(

      'ok',true,

      'response_id',response_id,

      'purchase_order_id',p.id,

      'commercial_response_only',true

    );

END;

$function$;


-- ==========================================
-- 4. SUPPLIER LPO RESPONSE HISTORY
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_lpo_responses(

    _branch uuid,

    _relationship uuid,

    _number text

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    order_id uuid;

BEGIN

    order_id := public.neo_supplier_lpo_response_scope(

      _branch,

      _relationship,

      _number

    );

    RETURN coalesce((

      SELECT jsonb_agg(

        to_jsonb(x)

        ORDER BY x.submitted_at DESC,x.id DESC

      )

      FROM (

        SELECT

          a.id,

          a.response_type,

          a.promised_delivery_date,

          a.notes,

          a.submitted_at

        FROM public.neo_supplier_lpo_acknowledgements a

        WHERE a.purchase_order_id = order_id

          AND a.branch_id = _branch

        ORDER BY a.submitted_at DESC,a.id DESC

        LIMIT 100

      ) x

    ),'[]'::jsonb);

END;

$function$;


-- ==========================================
-- 5. PROCUREMENT RESPONSE REGISTER
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_procurement_supplier_lpo_responses(

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

        public.has_permission(
          'procurement','quotations.manage'
        )

        OR public.has_permission(
          'procurement','orders.create'
        )

        OR public.has_permission(
          'procurement','lpos.create'
        )

        OR public.is_org_admin(),

        false

      )

    THEN

      RAISE EXCEPTION 'Procurement access denied'
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

          a.id,

          a.purchase_order_id,

          p.order_number,

          p.status AS order_status,

          p.expected_date,

          a.supplier_id,

          s.name AS supplier_name,

          a.branch_id,

          a.response_type,

          a.promised_delivery_date,

          a.notes,

          a.submitted_at

        FROM public.neo_supplier_lpo_acknowledgements a

        JOIN public.purchase_orders p

          ON p.id = a.purchase_order_id

          AND p.organization_id = a.organization_id

          AND p.branch_id = a.branch_id

          AND p.supplier_id = a.supplier_id

        JOIN public.suppliers s

          ON s.id = a.supplier_id

          AND s.organization_id = a.organization_id

        WHERE a.organization_id = org

          AND (

            _branch IS NULL

            OR a.branch_id = _branch

          )

          AND public.neo_branch_in_scope(
            a.branch_id
          ) IS TRUE

        ORDER BY a.submitted_at DESC,a.id DESC

        LIMIT 300

      ) x

    ),'[]'::jsonb);

END;

$function$;


REVOKE ALL ON FUNCTION
public.neo_partner_supplier_lpo_respond(
  uuid,uuid,text,text,date,text,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_lpo_respond(
  uuid,uuid,text,text,date,text,uuid
)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_partner_supplier_lpo_responses(
  uuid,uuid,text
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_lpo_responses(
  uuid,uuid,text
)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_procurement_supplier_lpo_responses(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_procurement_supplier_lpo_responses(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;