BEGIN;

CREATE OR REPLACE FUNCTION
public.neo_guard_inventory_managed_journal_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_old_journal uuid;
    v_new_journal uuid;
BEGIN

    IF TG_OP IN ('UPDATE','DELETE') THEN
        v_old_journal := OLD.journal_id;
    END IF;

    IF TG_OP IN ('INSERT','UPDATE') THEN
        v_new_journal := NEW.journal_id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.journal_entries j
        WHERE j.id IN (v_old_journal,v_new_journal)
          AND j.status = 'posted'
          AND j.source_document_type IN (
              'inventory_posting_event:consumption_cogs',
              'inventory_finance_reversal:restoration_cogs'
          )
    ) THEN

        RAISE EXCEPTION
            'Posted inventory journal lines are immutable. Use a verified compensating journal.'
            USING ERRCODE = '55000';

    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;

END;
$function$;

DO $guard$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'journal_entry_lines'
          AND column_name = 'journal_id'
    ) THEN
        RAISE EXCEPTION
            'Journal line relationship requires schema verification';
    END IF;

END;
$guard$;

DROP TRIGGER IF EXISTS
neo_inventory_managed_journal_line_guard
ON public.journal_entry_lines;

CREATE TRIGGER
neo_inventory_managed_journal_line_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.journal_entry_lines
FOR EACH ROW
EXECUTE FUNCTION
public.neo_guard_inventory_managed_journal_lines();

REVOKE ALL ON FUNCTION
public.neo_guard_inventory_managed_journal_lines()
FROM PUBLIC,anon,authenticated;

COMMIT;