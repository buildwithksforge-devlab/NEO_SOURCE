-- Read-only. Compare the four deployed functions with the reviewed definitions.
WITH expected (operation, signature, legacy_digest, hardened_digest) AS (VALUES
  ('open', 'public.neo_payment_intent_open(text,uuid,text,numeric,uuid,text,text,text,uuid)', '4c6ef2d349d2aa8949d9718cd1389d82', 'c3484224fabca9c860ae53dc6ec0fb0c'),
  ('mark_sent', 'public.neo_payment_intent_mark_sent(uuid,text,text,boolean)', '05af1958e408d3280a9ee461ee16f4b9', '5c9e058857b8dcac1a9f1f3585a79b22'),
  ('claim', 'public.neo_payment_intent_claim_dispatch(uuid,text)', NULL, 'e65990443b9774570eb340bf53c48c92'),
  ('apply', 'public.neo_payment_intent_apply(text,text,text,text,jsonb)', 'affdacd43bd2b9f451158084f8c826da', '31ec2b94cb99182ed67cbe3ebf80607e')
), installed AS (
  SELECT e.*, to_regprocedure(e.signature) AS fn FROM expected e
), definitions AS (
  SELECT i.*, md5(pg_get_functiondef(i.fn)) AS definition_digest FROM installed i
)
SELECT operation, definition_digest,
  CASE WHEN fn IS NULL AND operation = 'claim' THEN 'missing_claim'
       WHEN definition_digest = legacy_digest THEN 'legacy'
       WHEN definition_digest = hardened_digest THEN 'dispatch_safe'
       WHEN operation = 'apply' AND definition_digest = '03850d0aa1f26c01e035b3191740266f' THEN 'refund_safe'
       ELSE 'review_required' END AS deployment_state,
  has_function_privilege('anon', fn, 'EXECUTE') AS anonymous_can_execute,
  has_function_privilege('authenticated', fn, 'EXECUTE') AS browser_can_execute,
  has_function_privilege('service_role', fn, 'EXECUTE') AS service_can_execute
FROM definitions
ORDER BY operation;
