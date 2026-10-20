-- Transactional audit coverage for blind receiving.
-- Existing counts are not modified or backfilled.

BEGIN;

CREATE OR REPLACE FUNCTION public.neo_audit_blind_receiving_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_before jsonb;
    v_after jsonb;
    v_row jsonb;
    v_count public.neo_blind_receiving_counts%ROWTYPE;
    v_count_id uuid;
    v_action text;
    v_audit_id uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        v_before := to_jsonb(OLD);
    END IF;

    IF TG_OP <> 'DELETE' THEN
        v_after := to_jsonb(NEW);
    END IF;

    IF TG_OP = 'UPDATE'
       AND v_before IS NOT DISTINCT FROM v_after THEN
        RETURN NEW;
    END IF;

    v_row := COALESCE(v_after, v_before);

    IF TG_TABLE_NAME = 'neo_blind_receiving_counts' THEN
        v_count_id := (v_row->>'id')::uuid;

        SELECT *
        INTO v_count
        FROM public.neo_blind_receiving_counts
        WHERE id = v_count_id;

        v_action := CASE
            WHEN TG_OP = 'INSERT'
                THEN 'receiving.count.submitted'
            WHEN OLD.status IS DISTINCT FROM NEW.status
                THEN 'receiving.count.' || NEW.status
            ELSE 'receiving.count.updated'
        END;
    ELSE
        v_count_id := (v_row->>'count_id')::uuid;

        SELECT *
        INTO v_count
        FROM public.neo_blind_receiving_counts
        WHERE id = v_count_id;

        v_action := 'receiving.count.line.' || lower(TG_OP);
    END IF;

    IF v_count.id IS NULL THEN
        RAISE EXCEPTION 'Receiving audit parent count not found';
    END IF;

    IF auth.uid() IS NULL
       OR v_count.organization_id
          IS DISTINCT FROM public.current_org_id() THEN
        RAISE EXCEPTION 'Receiving audit requires matching authenticated workspace'
            USING ERRCODE = '42501';
    END IF;

    v_audit_id := public.log_audit_event(
        _action := v_action,
        _module := 'procurement',
        _record_id := v_count_id::text,
        _previous := v_before,
        _new := v_after,
        _reason := CASE
            WHEN TG_TABLE_NAME = 'neo_blind_receiving_counts'
                THEN COALESCE(
                    NULLIF(v_count.review_notes, ''),
                    v_count.remarks
                )
            ELSE 'Physical receiving line recorded or changed'
        END,
        _branch := v_count.branch_id,
        _correlation := v_count_id::text
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.audit_logs a
        WHERE a.id = v_audit_id
          AND a.organization_id = v_count.organization_id
          AND a.user_id = auth.uid()
          AND a.record_id = v_count_id::text
          AND a.created_at >= transaction_timestamp()
          AND a.created_at < transaction_timestamp() + interval '1 day'
    ) THEN
        RAISE EXCEPTION 'Receiving audit entry failed workspace or actor verification';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_audit_blind_receiving_change()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS neo_blind_receiving_count_audit
ON public.neo_blind_receiving_counts;

CREATE TRIGGER neo_blind_receiving_count_audit
AFTER INSERT OR UPDATE
ON public.neo_blind_receiving_counts
FOR EACH ROW
EXECUTE FUNCTION public.neo_audit_blind_receiving_change();

DROP TRIGGER IF EXISTS neo_blind_receiving_line_audit
ON public.neo_blind_receiving_count_lines;

CREATE TRIGGER neo_blind_receiving_line_audit
AFTER INSERT OR UPDATE OR DELETE
ON public.neo_blind_receiving_count_lines
FOR EACH ROW
EXECUTE FUNCTION public.neo_audit_blind_receiving_change();

COMMIT;
