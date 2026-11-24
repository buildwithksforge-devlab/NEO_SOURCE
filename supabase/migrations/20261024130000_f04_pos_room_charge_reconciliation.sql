-- F04 POS room-charge reconciliation
CREATE OR REPLACE FUNCTION public.neo_finance_exception_register(_branch uuid DEFAULT NULL,_from date DEFAULT NULL,_to date DEFAULT NULL)
RETURNS TABLE(kind text,module text,reference text,source_id uuid,amount numeric,currency text,occurred_on date,age_days integer,status text,reason text,detail text,responsible text,action text,drill_to text,last_attempt timestamptz,attempts integer,last_error text,branch_id uuid,property text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE org uuid:=public.current_org_id(); today date:=current_date; BEGIN
 IF org IS NULL OR NOT(public.is_org_admin() OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.financial_state,s.source_module,coalesce(s.source_reference,s.source_id::text),s.source_id,s.amount,s.currency,s.occurred_at::date,greatest(0,today-s.occurred_at::date),s.financial_state,coalesce(s.blocking_reason,s.next_action),coalesce(s.blocking_reason,s.next_action),'Finance',coalesce(s.next_action,'Resolve at source and retry.'),q.drill_to,s.updated_at,coalesce(r.attempts,0),r.last_error,s.branch_id,b.name
 FROM public.canonical_transaction_states s LEFT JOIN public.branches b ON b.id=s.branch_id LEFT JOIN LATERAL(SELECT x.attempts,x.last_error FROM public.finance_posting_receipts x WHERE x.organization_id=s.organization_id AND public.neo_canonical_posting_module(x.source_module)=s.source_module AND x.source_id=s.source_id ORDER BY x.updated_at DESC LIMIT 1)r ON true LEFT JOIN LATERAL(SELECT x.drill_to FROM public.neo_finance_posting_queue(s.branch_id,s.occurred_at::date,s.occurred_at::date)x WHERE x.source_id=s.source_id LIMIT 1)q ON true
 WHERE s.organization_id=org AND s.financial_state IN('blocked','failed') AND (_branch IS NULL OR s.branch_id=_branch) AND (_from IS NULL OR s.occurred_at::date>=_from) AND (_to IS NULL OR s.occurred_at::date<=_to)
 UNION ALL
 SELECT 'blocked',public.neo_canonical_posting_module(r.source_module),coalesce(r.source_reference,r.source_id::text),r.source_id,r.amount,r.currency,coalesce(r.occurred_on,r.created_at::date),greatest(0,today-coalesce(r.occurred_on,r.created_at::date)),'blocked','Posting receipt is not backed by a balanced posted journal','Posting receipt is not backed by a balanced posted journal','Finance','Repair the journal link or reverse and repost.','/finance/posting',r.updated_at,r.attempts,r.last_error,r.branch_id,b.name
 FROM public.finance_posting_receipts r LEFT JOIN public.branches b ON b.id=r.branch_id LEFT JOIN LATERAL (
    SELECT x.*
    FROM public.journal_entries x
    WHERE x.organization_id = r.organization_id AND x.status = 'posted' AND abs(coalesce(x.total_debit,0) - coalesce(x.total_credit,0)) < 0.01 AND coalesce(x.total_debit,0) > 0
      AND x.branch_id IS NOT DISTINCT FROM r.branch_id
      AND (
          r.source_module <> 'pos'
          OR r.folio_line_id IS NULL
          OR EXISTS (
              SELECT 1
              FROM public.folio_lines fl
              WHERE fl.id = r.folio_line_id
                AND fl.organization_id = r.organization_id
                AND fl.branch_id = r.branch_id
                AND fl.source_module = 'pos'
                AND fl.source_record_uuid = r.source_id
          )
      )
      AND (
          (
    x.id = r.journal_id
    AND (
        r.source_module <> 'pos'
        OR r.folio_line_id IS NULL
        OR (
            x.source_document_id = r.folio_line_id
            AND x.source_document_type = 'folio_charge:revenue'
        )
    )
)
          OR (
              r.source_module = 'pos'
              AND r.folio_line_id IS NOT NULL
              AND x.source_document_id = r.folio_line_id
              AND x.source_document_type = 'folio_charge:revenue'
          )
      )
    ORDER BY
        CASE WHEN (
    x.id = r.journal_id
    AND (
        r.source_module <> 'pos'
        OR r.folio_line_id IS NULL
        OR (
            x.source_document_id = r.folio_line_id
            AND x.source_document_type = 'folio_charge:revenue'
        )
    )
) THEN 0 ELSE 1 END,
        x.created_at DESC
    LIMIT 1
) j ON true
 WHERE r.organization_id=org AND r.status='posted' AND (j.id IS NULL OR j.status<>'posted' OR abs(coalesce(j.total_debit,0)-coalesce(j.total_credit,0))>=0.01) AND (_branch IS NULL OR r.branch_id=_branch) AND (_from IS NULL OR coalesce(r.occurred_on,r.created_at::date)>=_from) AND (_to IS NULL OR coalesce(r.occurred_on,r.created_at::date)<=_to)
 ORDER BY 1,7 DESC;
END $$;

-- Link a POS room-charge receipt to the actual posted folio journal.
-- Never create or repost a financial transaction.

CREATE OR REPLACE FUNCTION public.neo_pos_room_charge_receipt_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_journal uuid;
BEGIN
    IF NEW.source_module <> 'pos'
       OR NEW.folio_line_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT j.id
      INTO v_journal
      FROM public.folio_lines fl
      JOIN public.journal_entries j
        ON j.organization_id = fl.organization_id
       AND j.branch_id = fl.branch_id
       AND j.source_document_id = fl.id
       AND j.source_document_type = 'folio_charge:revenue'
       AND j.status = 'posted'
       AND abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01
       AND coalesce(j.total_debit,0) > 0
     WHERE fl.id = NEW.folio_line_id
       AND fl.organization_id = NEW.organization_id
       AND fl.branch_id = NEW.branch_id
       AND fl.source_module = 'pos'
       AND fl.source_record_uuid = NEW.source_id
     ORDER BY j.created_at DESC
     LIMIT 1;

    IF v_journal IS NOT NULL THEN
        NEW.journal_id := v_journal;
        NEW.status := 'posted';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pos_room_charge_receipt_link
ON public.finance_posting_receipts;

CREATE TRIGGER trg_pos_room_charge_receipt_link
BEFORE INSERT OR UPDATE
ON public.finance_posting_receipts
FOR EACH ROW
EXECUTE FUNCTION public.neo_pos_room_charge_receipt_link();