DO $$
DECLARE r record; res jsonb;
BEGIN
  FOR r IN
    SELECT fr.id AS receipt_id, m.id AS movement_id
      FROM public.finance_posting_receipts fr
      JOIN public.stock_movements m ON m.id = fr.source_id
     WHERE fr.status IN ('failed','blocked')
       AND fr.source_module = 'inventory'
       AND m.movement_type IN ('opening','receipt')
  LOOP
    res := public.neo_stock_movement_accrual(r.movement_id);
    IF coalesce((res->>'ok')::boolean, true) THEN
      UPDATE public.finance_posting_receipts
         SET status = 'posted', last_error = NULL, updated_at = now()
       WHERE id = r.receipt_id;
      UPDATE public.canonical_transaction_states
         SET financial_state = 'posted', blocking_reason = NULL, next_action = NULL, updated_at = now()
       WHERE source_id = r.movement_id AND source_module = 'inventory';
    ELSE
      UPDATE public.finance_posting_receipts
         SET last_error = coalesce(res->>'detail', res->>'reason'), updated_at = now()
       WHERE id = r.receipt_id;
    END IF;
  END LOOP;
END $$;