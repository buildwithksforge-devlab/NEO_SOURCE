BEGIN READ ONLY;
WITH targets AS (
 SELECT id,publish_status,availability FROM public.menu_items
 WHERE organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
 AND id IN ('e8ad3125-9201-4415-b419-c38601e3e6ee'::uuid,'5244d491-670e-4323-8eb1-3c9cc8f72e35'::uuid)
), visible AS (
 SELECT m.id FROM (VALUES('delivery'),('pickup'),('room-service')) channel(fulfilment)
 CROSS JOIN LATERAL public.neo_public_menu('aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid,'2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid,channel.fulfilment) m
 WHERE m.id IN ('e8ad3125-9201-4415-b419-c38601e3e6ee'::uuid,'5244d491-670e-4323-8eb1-3c9cc8f72e35'::uuid)
)
SELECT jsonb_build_object('diagnostic_version','two-confirmed-qa-menu-postcheck-v1','read_only',current_setting('transaction_read_only'),
 'two_exact_items_unpublished',(SELECT count(*)=2 AND bool_and(publish_status='draft' AND availability='disabled') FROM targets),
 'public_channels_clear',NOT EXISTS(SELECT 1 FROM visible),
 'scope','Two exact QA products only; no deletion, price change, financial posting or historical transaction change.') AS diagnostic;
COMMIT;
