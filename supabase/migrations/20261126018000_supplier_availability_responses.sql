BEGIN;

CREATE TABLE public.neo_supplier_availability_responses (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    rfq_id uuid NOT NULL
      REFERENCES public.rfqs(id),

    supplier_id uuid NOT NULL
      REFERENCES public.suppliers(id),

    submitted_by uuid NOT NULL,

    response_lines jsonb NOT NULL,

    notes text,

    attempt_key uuid NOT NULL,

    submitted_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (organization_id,attempt_key),

    CHECK (jsonb_typeof(response_lines) = 'array')

);

CREATE INDEX neo_supplier_availability_lookup

ON public.neo_supplier_availability_responses (

    organization_id,
    branch_id,
    rfq_id,
    supplier_id,
    submitted_at DESC

);

ALTER TABLE public.neo_supplier_availability_responses
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.neo_supplier_availability_responses
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 2. SUPPLIER SUBMISSION TRANSACTION
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_partner_supplier_availability_submit(

    _branch uuid,

    _relationship uuid,

    _rfq uuid,

    _lines jsonb,

    _notes text,

    _attempt uuid

)
RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid;

    rel public.neo_access_relationships%ROWTYPE;

    f public.rfqs%ROWTYPE;

    saved public.neo_supplier_availability_responses%ROWTYPE;

    requested public.purchase_request_lines%ROWTYPE;

    item jsonb;

    line_id uuid;

    available numeric;

    lead_days integer;

    availability_state text;

    normalized jsonb := '[]'::jsonb;

    expected integer;

    response_id uuid;

BEGIN

    IF auth.uid() IS NULL
      OR _attempt IS NULL
      OR _branch IS NULL
    THEN

      RAISE EXCEPTION 'Authentication and transaction identity required'
        USING ERRCODE='42501';

    END IF;

    SELECT b.organization_id

    INTO org

    FROM public.branches b

    WHERE b.id = _branch

      AND b.active IS TRUE;

    SELECT *

    INTO rel

    FROM public.neo_access_relationships r

    WHERE r.id = _relationship

      AND r.auth_user_id = auth.uid()

      AND r.door = 'partner'

      AND r.status = 'active'

      AND r.organization_id = org

      AND r.supplier_id IS NOT NULL

      AND (
        r.branch_id IS NULL
        OR r.branch_id = _branch
      );

    IF rel.id IS NULL THEN

      RAISE EXCEPTION 'Supplier access denied'
        USING ERRCODE='42501';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.suppliers s

      WHERE s.id = rel.supplier_id

        AND s.organization_id = org

        AND s.active IS TRUE

        AND public.neo_record_operationally_enabled(
          to_jsonb(s)
        ) IS TRUE

    ) THEN

      RAISE EXCEPTION 'Supplier is not operationally available';

    END IF;

    IF jsonb_typeof(_lines) IS DISTINCT FROM 'array'
      OR jsonb_array_length(_lines) = 0
    THEN

      RAISE EXCEPTION 'Availability response lines required';

    END IF;

    IF length(coalesce(_notes,'')) > 4000 THEN

      RAISE EXCEPTION 'Response notes are too long';

    END IF;

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        org::text ||
        ':supplier-availability:' ||
        _attempt::text,

        0

      )

    );

    SELECT *

    INTO saved

    FROM public.neo_supplier_availability_responses a

    WHERE a.organization_id = org

      AND a.attempt_key = _attempt;

    SELECT *

    INTO f

    FROM public.rfqs r

    WHERE r.id = _rfq

      AND r.organization_id = org

      AND r.branch_id = _branch

    FOR UPDATE;

    IF f.id IS NULL

      OR NOT EXISTS (

        SELECT 1

        FROM public.rfq_suppliers i

        WHERE i.organization_id = org

          AND i.rfq_id = f.id

          AND i.supplier_id = rel.supplier_id

          AND i.dispatch_state IN (

            'prepared',
            'ready-to-send',
            'downloaded',
            'marked-sent',
            'sent'

          )

      )

    THEN

      RAISE EXCEPTION 'RFQ is unavailable to this supplier'
        USING ERRCODE='42501';

    END IF;

    SELECT count(*)

    INTO expected

    FROM public.purchase_request_lines l

    WHERE l.organization_id = org

      AND l.request_id = f.request_id;

    IF expected = 0

      OR jsonb_array_length(_lines) <> expected

      OR (

        SELECT count(
          DISTINCT x->>'request_line_id'
        )

        FROM jsonb_array_elements(_lines) x

      ) <> expected

    THEN

      RAISE EXCEPTION 'Respond to every requested item exactly once';

    END IF;

    FOR item IN

      SELECT value

      FROM jsonb_array_elements(_lines)

    LOOP

      IF jsonb_typeof(item) <> 'object' THEN

        RAISE EXCEPTION 'Invalid response line';

      END IF;

      line_id := (item->>'request_line_id')::uuid;

      SELECT *

      INTO requested

      FROM public.purchase_request_lines l

      WHERE l.id = line_id

        AND l.organization_id = org

        AND l.request_id = f.request_id;

      IF requested.id IS NULL

        OR requested.quantity IS NULL

        OR requested.quantity <= 0

        OR requested.quantity::text IN (

          'NaN',
          'Infinity',
          '-Infinity'

        )

      THEN

        RAISE EXCEPTION 'Requested item is unavailable';

      END IF;

      available := (item->>'available_quantity')::numeric;

      lead_days := nullif(
        item->>'lead_time_days',''
      )::integer;

      IF available IS NULL

        OR available < 0

        OR available > requested.quantity

        OR available::text IN (

          'NaN',
          'Infinity',
          '-Infinity'

        )

      THEN

        RAISE EXCEPTION 'Invalid available quantity';

      END IF;

      IF lead_days IS NOT NULL

        AND lead_days NOT BETWEEN 0 AND 3650

      THEN

        RAISE EXCEPTION 'Invalid delivery lead time';

      END IF;

      availability_state := CASE

        WHEN available = 0
          THEN 'unavailable'

        WHEN available = requested.quantity
          THEN 'available'

        ELSE 'partial'

      END;

      IF length(
        coalesce(item->>'alternative','')
      ) > 1000

        OR length(
          coalesce(item->>'notes','')
        ) > 1000

      THEN

        RAISE EXCEPTION 'Item response notes are too long';

      END IF;

      normalized := normalized || jsonb_build_array(

        jsonb_build_object(

          'request_line_id',requested.id,
          'description',requested.description,

          'requested_quantity',requested.quantity,

          'available_quantity',available,

          'unit',requested.unit,

          'availability',availability_state,

          'lead_time_days',lead_days,

          'alternative',nullif(
            btrim(item->>'alternative'),''
          ),

          'notes',nullif(
            btrim(item->>'notes'),''
          )

        )

      );

    END LOOP;

    SELECT jsonb_agg(x ORDER BY x->>'request_line_id')

    INTO normalized

    FROM jsonb_array_elements(normalized) x;

    IF saved.id IS NOT NULL THEN

      IF saved.rfq_id IS DISTINCT FROM _rfq

        OR saved.branch_id IS DISTINCT FROM _branch

        OR saved.supplier_id IS DISTINCT FROM rel.supplier_id

        OR saved.submitted_by IS DISTINCT FROM auth.uid()

        OR saved.response_lines IS DISTINCT FROM normalized

        OR saved.notes IS DISTINCT FROM nullif(
          btrim(_notes),''
        )

      THEN

        RAISE EXCEPTION 'Availability retry payload mismatch';

      END IF;

      RETURN jsonb_build_object(

        'ok',true,

        'response_id',saved.id,

        'duplicate_prevented',true

      );

    END IF;

    IF f.status IS DISTINCT FROM 'issued'

      OR (
        f.closes_at IS NOT NULL
        AND CURRENT_DATE > f.closes_at::date
      )

    THEN

      RAISE EXCEPTION 'RFQ is closed';

    END IF;

    PERFORM 1

    FROM public.purchase_requests p

    WHERE p.id = f.request_id

      AND p.organization_id = org

      AND p.status = 'approved'

    FOR UPDATE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Request is no longer available';

    END IF;

    IF EXISTS (

      SELECT 1

      FROM public.purchase_orders p

      WHERE p.organization_id = org

        AND p.request_id = f.request_id

        AND p.status NOT IN ('cancelled','voided')

    ) THEN

      RAISE EXCEPTION 'Request has already been ordered';

    END IF;

    IF EXISTS (

      SELECT 1

      FROM public.supplier_quotations q

      WHERE q.organization_id = org

        AND q.rfq_id = f.id

        AND q.supplier_id = rel.supplier_id

        AND q.status = 'selected'

    ) THEN

      RAISE EXCEPTION 'Selected quotation requires buyer review';

    END IF;

    INSERT INTO public.neo_supplier_availability_responses (

      organization_id,

      branch_id,

      rfq_id,

      supplier_id,

      submitted_by,

      response_lines,

      notes,

      attempt_key

    )

    VALUES (

      org,

      _branch,

      _rfq,

      rel.supplier_id,

      auth.uid(),

      normalized,

      nullif(btrim(_notes),''),

      _attempt

    )

    RETURNING id INTO response_id;

    -- A previous full quotation must not remain eligible
    -- if the supplier now reports insufficient availability.

    IF EXISTS (

      SELECT 1

      FROM jsonb_array_elements(normalized) x

      WHERE x->>'availability' <> 'available'

    ) THEN

      UPDATE public.supplier_quotations q

        SET status = 'superseded'

      WHERE q.organization_id = org

        AND q.rfq_id = f.id

        AND q.supplier_id = rel.supplier_id

        AND q.status = 'received'

        AND q.status <> 'selected';

    END IF;

    RETURN jsonb_build_object(

      'ok',true,

      'response_id',response_id,

      'commercial_response_only',true

    );

END;

$function$;


-- ==========================================
-- 3. PROCUREMENT TEAM RESPONSE HISTORY
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_procurement_supplier_availability_history(

    _rfq uuid

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    property uuid;

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

        OR public.is_org_admin(),

        false

      )

    THEN

      RAISE EXCEPTION 'Procurement access denied'
        USING ERRCODE='42501';

    END IF;

    SELECT f.branch_id

    INTO property

    FROM public.rfqs f

    WHERE f.id = _rfq

      AND f.organization_id = org;

    IF property IS NULL

      OR public.neo_branch_in_scope(property) IS NOT TRUE

    THEN

      RAISE EXCEPTION 'RFQ outside property access'
        USING ERRCODE='42501';

    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(

        to_jsonb(x)

        ORDER BY x.submitted_at DESC,x.id

      )

      FROM (

        SELECT

          a.id,

          a.rfq_id,

          a.supplier_id,

          a.submitted_at,

          a.response_lines,

          a.notes

        FROM public.neo_supplier_availability_responses a

        WHERE a.organization_id = org

          AND a.branch_id = property

          AND a.rfq_id = _rfq

        ORDER BY a.submitted_at DESC,a.id

        LIMIT 200

      ) x

    ),'[]'::jsonb);

END;

$function$;


REVOKE ALL ON FUNCTION
public.neo_partner_supplier_availability_submit(
  uuid,uuid,uuid,jsonb,text,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_partner_supplier_availability_submit(
  uuid,uuid,uuid,jsonb,text,uuid
)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_procurement_supplier_availability_history(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_procurement_supplier_availability_history(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;