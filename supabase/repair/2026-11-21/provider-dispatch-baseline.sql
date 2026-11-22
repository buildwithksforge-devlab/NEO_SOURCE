-- Read-only. Compare the four deployed functions with the reviewed definitions.
WITH expected (operation, signature, legacy_digest, hardened_digest) AS (VALUES
  ('open', 'public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text,text,uuid)', '4c6ef2d349d2aa8949d9718cd1389d82', '0cba63f4c4bb6bee534e34281623e1be'),
  ('mark_sent', 'public.neo_payment_intent_mark_sent(uuid,text,text,boolean)', '05af1958e408d3280a9ee461ee16f4b9', 'b1b50112cdcacafb86e3d9b11ef634fc'),
  ('claim', 'public.neo_payment_intent_claim_dispatch(uuid,text)', NULL, '4187dc0cd0abe2d438a274efd74aa1c6'),
  ('apply', 'public.neo_payment_intent_apply(text,text,text,text,jsonb)', 'affdacd43bd2b9f451158084f8c826da', '31ec2b94cb99182ed67cbe3ebf80607e')
), installed AS (
  SELECT e.*, to_regprocedure(e.signature) AS fn FROM expected e
), definitions AS (
  SELECT i.*, md5(pg_get_functiondef(i.fn)) AS definition_digest,
         md5(replace(pg_get_functiondef(i.fn), chr(13) || chr(10), chr(10))) AS normalized_digest
  FROM installed i
)
SELECT operation, definition_digest,
  CASE WHEN fn IS NULL AND operation = 'claim' THEN 'missing_claim'
       WHEN legacy_digest IN (definition_digest, normalized_digest) THEN 'legacy'
       WHEN hardened_digest IN (definition_digest, normalized_digest) THEN 'dispatch_safe'
       WHEN operation = 'apply' AND '03850d0aa1f26c01e035b3191740266f' IN (definition_digest, normalized_digest) THEN 'refund_safe'
       ELSE 'review_required' END AS deployment_state,
  has_function_privilege('anon', fn, 'EXECUTE') AS anonymous_can_execute,
  has_function_privilege('authenticated', fn, 'EXECUTE') AS browser_can_execute,
  has_function_privilege('service_role', fn, 'EXECUTE') AS service_can_execute
FROM definitions
ORDER BY operation;
