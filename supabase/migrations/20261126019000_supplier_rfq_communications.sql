BEGIN;

CREATE TABLE public.neo_supplier_rfq_messages (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    rfq_id uuid NOT NULL
      REFERENCES public.rfqs(id),

    supplier_id uuid NOT NULL
      REFERENCES public.suppliers(id),

    sender_id uuid NOT NULL,

    sender_type text NOT NULL
      CHECK (
        sender_type IN ('supplier','procurement')
      ),

    message_body text NOT NULL
      CHECK (
        length(btrim(message_body)) BETWEEN 1 AND 4000
      ),

    attempt_key uuid NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (organization_id,attempt_key)

);

CREATE INDEX neo_supplier_rfq_message_thread

ON public.neo_supplier_rfq_messages (

    organization_id,
    branch_id,
    rfq_id,
    supplier_id,
    created_at DESC

);

ALTER TABLE public.neo_supplier_rfq_messages
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.neo_supplier_rfq_messages
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 2. AUTHORITATIVE THREAD ACCESS
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_rfq_message_scope(

    _rfq uuid,

    _supplier uuid,

    _relationship uuid,

    _branch uuid

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid;

    supplier uuid;

    sender_type text;

    f public.rfqs%ROWTYPE;

    rel public.neo_access_relationships%ROWTYPE;

BEGIN

    IF auth.uid() IS NULL
      OR _rfq IS NULL
    THEN

      RAISE EXCEPTION 'Authentication required'
        USING ERRCODE='42501';

    END IF;

    IF _relationship IS NOT NULL THEN

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
        OR _branch IS NULL
      THEN

        RAISE EXCEPTION 'Supplier access denied'
          USING ERRCODE='42501';

      END IF;

      org := rel.organization_id;

      supplier := rel.supplier_id;

      sender_type := 'supplier';

      IF _supplier IS NOT NULL

        AND _supplier IS DISTINCT FROM supplier

      THEN

        RAISE EXCEPTION 'Supplier identity mismatch'
          USING ERRCODE='42501';

      END IF;

    ELSE

      org := public.current_org_id();

      supplier := _supplier;

      sender_type := 'procurement';

      IF org IS NULL

        OR supplier IS NULL

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

    END IF;

    SELECT *

    INTO f

    FROM public.rfqs r

    WHERE r.id = _rfq

      AND r.organization_id = org;

    IF f.id IS NULL THEN

      RAISE EXCEPTION 'RFQ not accessible'
        USING ERRCODE='42501';

    END IF;

    IF sender_type = 'supplier' THEN

      IF f.branch_id IS DISTINCT FROM _branch THEN

        RAISE EXCEPTION 'Property access denied'
          USING ERRCODE='42501';

      END IF;

      IF NOT EXISTS (

        SELECT 1

        FROM public.branches b

        WHERE b.id = f.branch_id

          AND b.organization_id = org

          AND b.active IS TRUE

      ) THEN

        RAISE EXCEPTION 'Property is unavailable'
          USING ERRCODE='42501';

      END IF;

    ELSE

      IF public.neo_branch_in_scope(
        f.branch_id
      ) IS NOT TRUE THEN

        RAISE EXCEPTION 'Property access denied'
          USING ERRCODE='42501';

      END IF;

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.rfq_suppliers i

      WHERE i.rfq_id = f.id

        AND i.organization_id = org

        AND i.supplier_id = supplier

        AND i.dispatch_state IN (

          'prepared',

          'ready-to-send',

          'downloaded',

          'marked-sent',

          'sent'

        )

    ) THEN

      RAISE EXCEPTION 'Supplier invitation not found'
        USING ERRCODE='42501';

    END IF;

    RETURN jsonb_build_object(

      'organization_id',org,

      'branch_id',f.branch_id,

      'rfq_id',f.id,

      'supplier_id',supplier,

      'sender_type',sender_type,

      'rfq_status',f.status

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_supplier_rfq_message_scope(
  uuid,uuid,uuid,uuid
)
FROM PUBLIC,anon,authenticated;


-- ==========================================
-- 3. SEND MESSAGE
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_rfq_message_send(

    _rfq uuid,

    _supplier uuid,

    _relationship uuid,

    _branch uuid,

    _message text,

    _attempt uuid

)
RETURNS jsonb

LANGUAGE plpgsql

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    scope jsonb;

    org uuid;

    property uuid;

    supplier uuid;

    actor_type text;

    body text;

    saved public.neo_supplier_rfq_messages%ROWTYPE;

    message_id uuid;

BEGIN

    scope := public.neo_supplier_rfq_message_scope(

      _rfq,

      _supplier,

      _relationship,

      _branch

    );

    org := (scope->>'organization_id')::uuid;

    property := (scope->>'branch_id')::uuid;

    supplier := (scope->>'supplier_id')::uuid;

    actor_type := scope->>'sender_type';

    body := btrim(coalesce(_message,''));

    IF _attempt IS NULL

      OR length(body) NOT BETWEEN 1 AND 4000

    THEN

      RAISE EXCEPTION 'Invalid message or transaction identity'
        USING ERRCODE='22023';

    END IF;

    PERFORM pg_advisory_xact_lock(

      hashtextextended(

        org::text ||

        ':supplier-message:' ||

        _attempt::text,

        0

      )

    );

    SELECT *

    INTO saved

    FROM public.neo_supplier_rfq_messages m

    WHERE m.organization_id = org

      AND m.attempt_key = _attempt;

    IF saved.id IS NOT NULL THEN

      IF saved.rfq_id IS DISTINCT FROM _rfq

        OR saved.branch_id IS DISTINCT FROM property

        OR saved.supplier_id IS DISTINCT FROM supplier

        OR saved.sender_id IS DISTINCT FROM auth.uid()

        OR saved.sender_type IS DISTINCT FROM actor_type

        OR saved.message_body IS DISTINCT FROM body

      THEN

        RAISE EXCEPTION 'Message retry payload mismatch'
          USING ERRCODE='22023';

      END IF;

      RETURN jsonb_build_object(

        'ok',true,

        'message_id',saved.id,

        'duplicate_prevented',true

      );

    END IF;

    IF scope->>'rfq_status' IN (
      'cancelled','voided','draft'
    ) THEN

      RAISE EXCEPTION 'This RFQ does not accept messages';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.suppliers s

      WHERE s.id = supplier

        AND s.organization_id = org

        AND s.active IS TRUE

        AND public.neo_record_operationally_enabled(
          to_jsonb(s)
        ) IS TRUE

    ) THEN

      RAISE EXCEPTION 'Supplier is not operationally available';

    END IF;

    INSERT INTO public.neo_supplier_rfq_messages (

      organization_id,

      branch_id,

      rfq_id,

      supplier_id,

      sender_id,

      sender_type,

      message_body,

      attempt_key

    )

    VALUES (

      org,

      property,

      _rfq,

      supplier,

      auth.uid(),

      actor_type,

      body,

      _attempt

    )

    RETURNING id INTO message_id;

    RETURN jsonb_build_object(

      'ok',true,

      'message_id',message_id

    );

END;

$function$;


-- ==========================================
-- 4. THREAD HISTORY
-- ==========================================

CREATE OR REPLACE FUNCTION
public.neo_supplier_rfq_message_history(

    _rfq uuid,

    _supplier uuid,

    _relationship uuid,

    _branch uuid

)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    scope jsonb;

BEGIN

    scope := public.neo_supplier_rfq_message_scope(

      _rfq,

      _supplier,

      _relationship,

      _branch

    );

    RETURN coalesce((

      SELECT jsonb_agg(

        to_jsonb(x)

        ORDER BY x.created_at,x.id

      )

      FROM (

        SELECT

          m.id,

          m.sender_type,

          m.message_body,

          m.created_at

        FROM public.neo_supplier_rfq_messages m

        WHERE m.organization_id =
          (scope->>'organization_id')::uuid

          AND m.branch_id =
            (scope->>'branch_id')::uuid

          AND m.rfq_id = _rfq

          AND m.supplier_id =
            (scope->>'supplier_id')::uuid

        ORDER BY m.created_at DESC,m.id DESC

        LIMIT 200

      ) x

    ),'[]'::jsonb);

END;

$function$;


REVOKE ALL ON FUNCTION
public.neo_supplier_rfq_message_send(
  uuid,uuid,uuid,uuid,text,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_supplier_rfq_message_send(
  uuid,uuid,uuid,uuid,text,uuid
)
TO authenticated;

REVOKE ALL ON FUNCTION
public.neo_supplier_rfq_message_history(
  uuid,uuid,uuid,uuid
)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_supplier_rfq_message_history(
  uuid,uuid,uuid,uuid
)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;