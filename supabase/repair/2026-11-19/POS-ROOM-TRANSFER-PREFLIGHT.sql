-- READ ONLY. Compare installed source before installing the guarded candidate.
-- No payment, transfer, reconciliation or other business routine is called.
SELECT jsonb_build_object(
 'installed_transfer',(
  SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'owner',r.rolname,'security_definer',p.prosecdef,
   'body_hash',md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')),
   'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
   'anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
   'definition',pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid=to_regprocedure('public.pos_post_room_charge(uuid,uuid,text)')
 ),
 'existing_money_guards',coalesce((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'trigger',t.tgname,
   'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid))) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgrelid IN (to_regclass('public.pos_payments'),to_regclass('public.cash_payment_requests'))),'[]'::jsonb),
 'supplied_order',(
  SELECT jsonb_build_object('id',o.id,'organization_id',o.organization_id,'branch_id',o.branch_id,
   'status',o.status,'payment_status',o.payment_status,'folio_id',o.folio_id,'folio_post_status',o.folio_post_status,
   'grand_total',o.grand_total,'paid_total',o.paid_total,
   'pos_payment_rows',(SELECT count(*) FROM public.pos_payments p WHERE p.order_id=o.id),
   'cash_request_rows',(SELECT count(*) FROM public.cash_payment_requests request WHERE request.source_module='pos' AND request.source_record_id=o.id))
  FROM public.pos_orders o WHERE o.id='1b6b23aa-c4d8-4ded-830e-4f432e972175'::uuid
 )
) AS pos_room_transfer_preflight;
