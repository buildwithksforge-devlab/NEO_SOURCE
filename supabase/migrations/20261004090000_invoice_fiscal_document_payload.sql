-- Add stored KRA eTIMS result data to the canonical invoice document payload.
-- Financial values remain sourced exclusively from the posted invoice record.

DO $mig$
DECLARE
  src text;

  old_invoice text := $old$
  elsif _type = 'invoice' then
    select v.organization_id, v.branch_id, v.currency,
           jsonb_build_object('number', v.invoice_number, 'date', v.issue_date, 'status', v.status,
             'title', case when v.document_type = 'credit_note' then 'Credit note' else 'Tax invoice' end,
             'subtitle', case when v.due_date is null then null else 'Due ' || v.due_date::text end),
           jsonb_build_object('label','Bill to','name', coalesce(v.bill_to_snapshot->>'name','Not configured'),
             'lines', jsonb_build_array(coalesce(v.bill_to_snapshot->>'address',''), coalesce(v.bill_to_snapshot->>'tax_id',''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price,
               'discount', l.discount_amount, 'tax', l.tax_amount, 'total', l.total_amount)
               order by l.line_number)
             from invoice_lines l where l.invoice_id = v.id), '[]'::jsonb),
           jsonb_build_array(
             jsonb_build_object('label','Subtotal','amount',v.subtotal),
             jsonb_build_object('label','Discount','amount',-v.discount_total),
             jsonb_build_object('label','Service charge','amount',v.service_charge_total),
             jsonb_build_object('label','Tax','amount',v.tax_total),
             jsonb_build_object('label','Total','amount',v.total,'emphasis',true),
             jsonb_build_object('label','Amount paid','amount',v.amount_paid),
             jsonb_build_object('label','Balance due','amount',v.balance)),
           jsonb_strip_nulls(jsonb_build_object('Fiscalisation', v.etims_status, 'Notes', v.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from invoices v where v.id = _id;
$old$;

  new_invoice text := $new$
  elsif _type = 'invoice' then
    select v.organization_id, v.branch_id, v.currency,
           jsonb_build_object('number', v.invoice_number, 'date', v.issue_date, 'status', v.status,
             'title', case when v.document_type = 'credit_note' then 'Credit note' else 'Tax invoice' end,
             'subtitle', case when v.due_date is null then null else 'Due ' || v.due_date::text end),
           jsonb_build_object('label','Bill to','name', coalesce(v.bill_to_snapshot->>'name','Not configured'),
             'lines', jsonb_build_array(coalesce(v.bill_to_snapshot->>'address',''), coalesce(v.bill_to_snapshot->>'tax_id',''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price,
               'discount', l.discount_amount, 'tax', l.tax_amount, 'total', l.total_amount)
               order by l.line_number)
             from invoice_lines l where l.invoice_id = v.id), '[]'::jsonb),
           jsonb_build_array(
             jsonb_build_object('label','Subtotal','amount',v.subtotal),
             jsonb_build_object('label','Discount','amount',-v.discount_total),
             jsonb_build_object('label','Service charge','amount',v.service_charge_total),
             jsonb_build_object('label','Tax','amount',v.tax_total),
             jsonb_build_object('label','Total','amount',v.total,'emphasis',true),
             jsonb_build_object('label','Amount paid','amount',v.amount_paid),
             jsonb_build_object('label','Balance due','amount',v.balance)),
           jsonb_strip_nulls(jsonb_build_object(
             'Fiscalisation', coalesce(es.status, v.etims_status),
             'KRA reference', es.kra_reference,
             'Control unit reference', es.control_unit_reference,
             'qr_payload', es.qr_payload,
             'Fiscal error', es.error_details,
             'Notes', v.notes
           ))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from invoices v
      left join lateral (
        select
          s.status,
          s.kra_reference,
          s.control_unit_reference,
          s.qr_payload,
          s.error_details
        from etims_submissions s
        where s.organization_id = v.organization_id
          and s.invoice_id = v.id
        order by s.updated_at desc, s.created_at desc
        limit 1
      ) es on true
      where v.id = _id;
$new$;

BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO src
    FROM pg_proc p
   WHERE p.proname = 'neo_document_payload'
     AND p.pronamespace = 'public'::regnamespace
     AND pg_get_function_identity_arguments(p.oid) = '_type text, _id uuid';

  IF src IS NULL THEN
    RAISE EXCEPTION 'neo_document_payload(text, uuid) not found.';
  END IF;

  IF position('''KRA reference''' in src) = 0 THEN
    IF position(old_invoice in src) = 0 THEN
      RAISE EXCEPTION 'Expected invoice payload branch not found. Migration stopped without changing the function.';
    END IF;

    src := replace(src, old_invoice, new_invoice);
    EXECUTE src;
  END IF;
END
$mig$;

REVOKE ALL
  ON FUNCTION public.neo_document_payload(text, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.neo_document_payload(text, uuid)
  TO authenticated, service_role;