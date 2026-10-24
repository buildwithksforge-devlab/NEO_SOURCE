-- NEÃ˜ F03 â€” Guest deposit liability clearing
-- DEF-MVJHOVVH
--
-- Post one liability-to-receivable transfer when a reservation
-- deposit changes from held to applied.
--
-- No new cash receipt.
-- No historical backfill.
-- Tenant and branch boundaries enforced.

CREATE OR REPLACE FUNCTION public.neo_guest_deposit_application_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_folio public.folios%ROWTYPE;
    v_original_posted boolean;
    v_result jsonb;
    v_journal_id uuid;
    v_amount numeric;
BEGIN
    -- Only an actual transition into applied is eligible.
    IF NEW.status IS DISTINCT FROM 'applied'
       OR OLD.status IS NOT DISTINCT FROM 'applied' THEN
        RETURN NEW;
    END IF;

    -- Application must represent an existing held deposit.
    IF OLD.status IS DISTINCT FROM 'held' THEN
        RAISE EXCEPTION
            'Cannot apply deposit % from status %',
            NEW.id, OLD.status;
    END IF;

    -- Prevent a deposit from being reassigned while applying.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
       OR NEW.amount IS DISTINCT FROM OLD.amount THEN
        RAISE EXCEPTION
            'Deposit identity, location and amount cannot change during application';
    END IF;

    v_amount := round(coalesce(NEW.amount, 0), 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Cannot apply a zero or negative deposit';
    END IF;

    -- The folio must belong to the same reservation and property.
    SELECT *
      INTO v_folio
      FROM public.folios
     WHERE id = NEW.applied_folio_id
       AND organization_id = NEW.organization_id
       AND branch_id = NEW.branch_id
       AND reservation_id = NEW.reservation_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Deposit application requires a matching guest folio';
    END IF;

    -- A source deposit must already have been posted to Finance.
    SELECT EXISTS (
        SELECT 1
          FROM public.finance_posting_receipts r
         WHERE r.organization_id = NEW.organization_id
           AND r.idempotency_key = 'deposit:' || NEW.id::text
           AND r.status = 'posted'
    )
    INTO v_original_posted;

    IF NOT v_original_posted THEN
        RAISE EXCEPTION
            'Cannot apply deposit % before its original receipt is posted',
            NEW.id;
    END IF;

    -- Existing GL posting function handles balanced journals
    -- and source-based idempotency.
    v_result := public.neo_gl_post(
        NEW.organization_id,
        NEW.branch_id,
        'pms',
        'reservation_deposit_application',
        NEW.id,
        'application',
        current_date,
        coalesce(
            nullif(NEW.currency, ''),
            public.neo_fact_currency(NEW.organization_id, NEW.branch_id)
        ),
        'Reservation deposit applied to guest folio',
        jsonb_build_array(
            jsonb_build_object(
                'code', '2020',
                'debit', v_amount,
                'description', 'Release guest deposit liability'
            ),
            jsonb_build_object(
                'code', '1060',
                'credit', v_amount,
                'description', 'Apply deposit to guest receivable'
            )
        ),
        NEW.customer_id
    );

    v_journal_id := nullif(v_result->>'journal_id', '')::uuid;

    -- Fail closed: never mark a deposit applied if Finance
    -- cannot confirm the clearing journal.
    IF v_journal_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id = v_journal_id AND organization_id = NEW.organization_id AND branch_id = NEW.branch_id AND status = 'posted') THEN
        RAISE EXCEPTION
            'Deposit application GL posting failed for %: %',
            NEW.id, v_result::text;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
    public.neo_guest_deposit_application_post()
FROM PUBLIC, anon;

-- This function executes through the trigger, not directly
-- as a customer-facing RPC.

DROP TRIGGER IF EXISTS trg_guest_deposit_application_post
ON public.reservation_deposits;

CREATE TRIGGER trg_guest_deposit_application_post
AFTER UPDATE OF status
ON public.reservation_deposits
FOR EACH ROW
WHEN (
    NEW.status = 'applied'
    AND OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.neo_guest_deposit_application_post();