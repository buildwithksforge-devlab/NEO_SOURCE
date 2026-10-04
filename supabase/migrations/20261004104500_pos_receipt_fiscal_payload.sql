-- Add stored eTIMS result data to the canonical POS receipt payload.
-- Financial amounts remain sourced exclusively from pos_orders / pos_order_items.

DO $migration$
DECLARE
  fn text;
  old_fragment text;
  new_fragment text;
BEGIN
  SELECT pg_get_functiondef(
    'public.neo_document_payload(text,uuid)'::regprocedure
  )
  INTO fn;

  IF position('pos_order_id' in fn) > 0
     AND position('KRA reference' in fn) > 0
     AND position('qr_payload' in fn) > 0 THEN
    RETURN;
  END IF;

  old_fragment := $old$
               'Payment status',
                 o.payment_status,

               'Payment receipts',
$old$;

  new_fragment := $new$
               'Payment status',
                 o.payment_status,

               'Fiscalisation',
                 (
                   select es.status
                   from public.etims_submissions es
                   where es.organization_id = o.organization_id
                     and es.pos_order_id = o.id
                   order by es.updated_at desc, es.created_at desc
                   limit 1
                 ),

               'KRA reference',
                 (
                   select es.kra_reference
                   from public.etims_submissions es
                   where es.organization_id = o.organization_id
                     and es.pos_order_id = o.id
                   order by es.updated_at desc, es.created_at desc
                   limit 1
                 ),

               'Control unit reference',
                 (
                   select es.control_unit_reference
                   from public.etims_submissions es
                   where es.organization_id = o.organization_id
                     and es.pos_order_id = o.id
                   order by es.updated_at desc, es.created_at desc
                   limit 1
                 ),

               'qr_payload',
                 (
                   select es.qr_payload
                   from public.etims_submissions es
                   where es.organization_id = o.organization_id
                     and es.pos_order_id = o.id
                   order by es.updated_at desc, es.created_at desc
                   limit 1
                 ),

               'Fiscal error',
                 (
                   select es.error_details
                   from public.etims_submissions es
                   where es.organization_id = o.organization_id
                     and es.pos_order_id = o.id
                   order by es.updated_at desc, es.created_at desc
                   limit 1
                 ),

               'Payment receipts',
$new$;

  IF position(old_fragment in fn) = 0 THEN
    RAISE EXCEPTION
      'Canonical POS receipt payment-status fragment was not found; migration refused to rewrite neo_document_payload.';
  END IF;

  fn := replace(fn, old_fragment, new_fragment);

  EXECUTE fn;
END
$migration$;

REVOKE ALL
ON FUNCTION public.neo_document_payload(text, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_document_payload(text, uuid)
TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';