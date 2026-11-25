BEGIN;

-- ============================================================
-- 1. Protect inventory financial posting evidence.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_guard_inventory_finance_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN

    IF current_user NOT IN ('authenticated','anon') THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN

        IF NEW.finance_posting_status IS NOT NULL
           OR NEW.finance_journal_id IS NOT NULL
           OR NEW.finance_posted_at IS NOT NULL
           OR NEW.finance_posting_error IS NOT NULL
           OR NEW.finance_attempt_count <> 0
           OR NEW.payload->>'valuation_status' IS NOT NULL
        THEN
            RAISE EXCEPTION
                'System-managed inventory financial evidence'
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;

    END IF;

    IF TG_OP = 'DELETE' THEN

        IF OLD.finance_posting_status IS NOT NULL THEN
            RAISE EXCEPTION
                'Financial inventory evidence cannot be deleted'
                USING ERRCODE = '42501';
        END IF;

        RETURN OLD;

    END IF;

    IF NEW.finance_posting_status
           IS DISTINCT FROM OLD.finance_posting_status
       OR NEW.finance_journal_id
           IS DISTINCT FROM OLD.finance_journal_id
       OR NEW.finance_posted_at
           IS DISTINCT FROM OLD.finance_posted_at
       OR NEW.finance_posting_error
           IS DISTINCT FROM OLD.finance_posting_error
       OR NEW.finance_attempt_count
           IS DISTINCT FROM OLD.finance_attempt_count
       OR NEW.payload->>'valuation_status'
           IS DISTINCT FROM OLD.payload->>'valuation_status'
    THEN
        RAISE EXCEPTION
            'System-managed inventory financial evidence'
            USING ERRCODE = '42501';
    END IF;

    IF OLD.finance_posting_status IS NOT NULL
       AND NEW IS DISTINCT FROM OLD
    THEN
        RAISE EXCEPTION
            'Financial consumption evidence is immutable to clients'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_inventory_finance_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.inventory_posting_events
FOR EACH ROW
EXECUTE FUNCTION public.neo_guard_inventory_finance_evidence();

-- ============================================================
-- 2. Authorised consumption finance retries.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_retry_inventory_consumption_finance(
    _event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    e public.inventory_posting_events;
BEGIN

    IF auth.uid() IS NULL
       OR public.current_org_id() IS NULL
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission('finance','approve') IS TRUE
       )
    THEN
        RAISE EXCEPTION 'Financial approval permission required'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO e
    FROM public.inventory_posting_events
    WHERE id = _event_id
      AND organization_id = public.current_org_id()
    FOR UPDATE;

    IF NOT FOUND
       OR public.neo_branch_in_scope(e.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Inventory event unavailable'
            USING ERRCODE = '42501';
    END IF;

    IF e.finance_posting_status IS NULL THEN
        RETURN jsonb_build_object(
            'status','legacy-excluded'
        );
    END IF;

    IF e.status = 'reversed'
       AND e.finance_posting_status IN (
           'pending','failed','unverified'
       )
    THEN

        RETURN jsonb_build_object(
            'status','coordinated-recovery-required',
            'event_id',e.id,
            'detail',
                'Original COGS and restoration accounting must be reconciled together.'
        );

    END IF;

    RETURN public.neo_inventory_post_consumption_finance(
        e.id
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_retry_inventory_consumption_finance(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_retry_inventory_consumption_finance(uuid)
TO authenticated;

-- ============================================================
-- 3. Authorised financial restoration retries.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_retry_inventory_restoration_finance(
    _reversal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    r public.neo_inventory_finance_reversals;
BEGIN

    IF auth.uid() IS NULL
       OR public.current_org_id() IS NULL
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission('finance','approve') IS TRUE
       )
    THEN
        RAISE EXCEPTION 'Financial approval permission required'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO r
    FROM public.neo_inventory_finance_reversals
    WHERE id = _reversal_id
      AND organization_id = public.current_org_id();

    IF NOT FOUND
       OR public.neo_branch_in_scope(r.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Inventory restoration unavailable'
            USING ERRCODE = '42501';
    END IF;

    RETURN public.neo_inventory_post_restoration_finance(
        r.consumption_event_id,
        r.original_stock_movement_id,
        r.restoration_stock_movement_id
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_retry_inventory_restoration_finance(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_retry_inventory_restoration_finance(uuid)
TO authenticated;

-- ============================================================
-- 4. Financial reconciliation register.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_inventory_finance_exceptions(
    _limit integer DEFAULT 100, _branch uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_limit integer;
    v_consumption jsonb;
    v_restoration jsonb;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR NOT (
           public.is_org_admin() IS TRUE
           OR public.has_permission('finance','view') IS TRUE
           OR public.has_permission('finance','approve') IS TRUE
       )
    THEN
        RAISE EXCEPTION 'Finance access required'
            USING ERRCODE = '42501';
    END IF;

    IF _branch IS NOT NULL
       AND public.neo_branch_in_scope(_branch) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Property outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    v_limit := greatest(
        1,
        least(coalesce(_limit,100),500)
    );

    SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)
    INTO v_consumption
    FROM (
        SELECT
            e.id,
            e.branch_id,
            e.order_item_id,
            e.created_at,
            e.cost_snapshot,
            e.finance_posting_status AS status,
            e.finance_posting_error AS error,
            e.finance_attempt_count AS attempts,
            e.payload->>'valuation_status'
                AS valuation_status
        FROM public.inventory_posting_events e
        WHERE e.organization_id = v_org
          AND (_branch IS NULL OR e.branch_id = _branch)
          AND public.neo_branch_in_scope(e.branch_id) IS TRUE
          AND e.finance_posting_status IN (
              'pending','failed','unverified'
          )
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT v_limit
    ) x;

    SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)
    INTO v_restoration
    FROM (
        SELECT
            r.id,
            r.branch_id,
            r.consumption_event_id,
            r.original_stock_movement_id,
            r.restoration_stock_movement_id,
            r.accounting_date,
            r.restored_quantity,
            r.restored_value,
            r.status,
            r.posting_error AS error,
            r.attempt_count AS attempts
        FROM public.neo_inventory_finance_reversals r
        WHERE r.organization_id = v_org
          AND (_branch IS NULL OR r.branch_id = _branch)
          AND public.neo_branch_in_scope(r.branch_id) IS TRUE
          AND r.status IN (
              'pending','failed','unverified'
          )
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT v_limit
    ) x;

    RETURN jsonb_build_object(
        'consumption',v_consumption,
        'restoration',v_restoration,
        'limit_per_category',v_limit
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_inventory_finance_exceptions(integer,uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_inventory_finance_exceptions(integer,uuid)
TO authenticated;

-- ============================================================
-- 5. Protect system-managed inventory journals.
-- ============================================================

CREATE OR REPLACE FUNCTION
public.neo_guard_inventory_managed_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN

    IF OLD.source_document_type IN (
        'inventory_posting_event:consumption_cogs',
        'inventory_finance_reversal:restoration_cogs'
    )
    AND OLD.status = 'posted'
    THEN

        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION
                'System-managed inventory journal cannot be deleted'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.reversed_by_journal_id
               IS DISTINCT FROM OLD.reversed_by_journal_id
           OR NEW.reverses_journal_id
               IS DISTINCT FROM OLD.reverses_journal_id
           OR NEW.total_debit
               IS DISTINCT FROM OLD.total_debit
           OR NEW.total_credit
               IS DISTINCT FROM OLD.total_credit
           OR NEW.organization_id
               IS DISTINCT FROM OLD.organization_id
           OR NEW.branch_id
               IS DISTINCT FROM OLD.branch_id
           OR NEW.source_document_id
               IS DISTINCT FROM OLD.source_document_id
           OR NEW.source_document_type
               IS DISTINCT FROM OLD.source_document_type
           OR NEW.source_module
               IS DISTINCT FROM OLD.source_module
           OR NEW.currency
               IS DISTINCT FROM OLD.currency
           OR NEW.accounting_date
               IS DISTINCT FROM OLD.accounting_date
        THEN

            RAISE EXCEPTION
                'Use inventory reconciliation instead of independent journal reversal'
                USING ERRCODE = '23514';

        END IF;

    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;

END;
$function$;

CREATE TRIGGER neo_inventory_managed_journal_guard
BEFORE UPDATE OR DELETE
ON public.journal_entries
FOR EACH ROW
EXECUTE FUNCTION public.neo_guard_inventory_managed_journal();

COMMIT;