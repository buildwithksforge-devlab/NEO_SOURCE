-- Read-only. Verify the installed callback before changing payment behaviour.
WITH callback AS (
  SELECT oid, prosecdef, prosrc
  FROM pg_proc
  WHERE oid = to_regprocedure('public.neo_payment_intent_apply(text,text,text,text,jsonb)')
)
SELECT
  EXISTS (SELECT 1 FROM callback) AS callback_installed,
  EXISTS (SELECT 1 FROM callback WHERE prosecdef
    AND strpos(prosrc, 'extensions.digest') > 0
    AND strpos(prosrc, 'pos_reconcile_settlement_internal') > 0
    AND strpos(prosrc, 'WHEN ''refunded'' THEN ''refunded''') > 0
    AND strpos(prosrc, 'payment.intent.refund_observed') = 0) AS matches_legacy_baseline,
  EXISTS (SELECT 1 FROM callback WHERE prosecdef
    AND strpos(prosrc, 'payment.intent.refund_observed') > 0
    AND strpos(prosrc, 'refund_reconciliation_required') > 0) AS refund_guard_installed,
  (SELECT md5(pg_get_functiondef(oid)) FROM callback) AS definition_digest,
  (SELECT has_function_privilege('service_role', oid, 'EXECUTE') FROM callback) AS service_can_apply,
  (SELECT has_function_privilege('anon', oid, 'EXECUTE') FROM callback) AS anonymous_can_apply,
  (SELECT has_function_privilege('authenticated', oid, 'EXECUTE') FROM callback) AS browser_can_apply;
