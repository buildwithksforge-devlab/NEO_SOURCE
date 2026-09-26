DO $patch$
DECLARE _def text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='neo_posting_plan';
  IF _def IS NULL THEN RAISE EXCEPTION 'neo_posting_plan not found'; END IF;

  _old := 'SELECT id, status, amount, currency, attempts, detail, last_error, posted_at,
           posting_type, journal_id, reverses_receipt_id
      FROM public.finance_posting_receipts
     WHERE organization_id = org AND source_id = _source';
  _new := 'SELECT fpr.id, fpr.status, fpr.amount, fpr.currency, fpr.attempts, fpr.detail,
           fpr.last_error, fpr.posted_at, fpr.posting_type, fpr.journal_id, fpr.reverses_receipt_id
      FROM public.finance_posting_receipts fpr
     WHERE fpr.organization_id = org AND fpr.source_id = _source';

  IF position(_old in _def) = 0 THEN
    RAISE EXCEPTION 'receipt lookup fragment not found — aborting rather than guessing';
  END IF;

  _def := replace(_def, _old, _new);
  _def := replace(_def, 'ORDER BY updated_at DESC LIMIT 1) r;', 'ORDER BY fpr.updated_at DESC LIMIT 1) r;');
  EXECUTE _def;
END $patch$;