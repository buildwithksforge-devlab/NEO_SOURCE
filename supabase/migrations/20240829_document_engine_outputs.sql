CREATE OR REPLACE FUNCTION public.neo_document_payload(_type text, _id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _org uuid;
  _branch uuid;
  _module text;
  _doc jsonb := '{}'::jsonb;
  _party jsonb := '{}'::jsonb;
  _lines jsonb := '[]'::jsonb;
  _totals jsonb := '[]'::jsonb;
  _meta jsonb := '{}'::jsonb;
  _currency text;
  _property jsonb;
  _identity jsonb;
begin
  _module := case _type
    when 'pos_receipt' then 'pos'
    when 'invoice' then 'finance'
    when 'folio_statement' then 'front-office'
    when 'beo' then 'events'
    when 'purchase_order' then 'procurement'
    when 'goods_receipt' then 'procurement'
    when 'requisition' then 'inventory'
    when 'stock_sheet' then 'inventory'
    when 'staff_schedule' then 'hr-scheduling'
    when 'task_sheet' then 'tasks'
    else null end;
  if _module is null then
    raise exception 'Unknown document type: %', _type;
  end if;

  if _type = 'pos_receipt' then
    select o.organization_id, o.branch_id, o.currency,
           jsonb_build_object(
             'number', o.order_number, 'date', coalesce(o.closed_at, o.created_at),
             'status', o.status, 'title', 'Sales receipt', 'subtitle', initcap(replace(o.order_type,'_',' '))),
           jsonb_build_object('label','Billed to','name', coalesce(o.guest_name,'Walk-in guest'),
             'lines', jsonb_build_array(coalesce(o.contact_phone,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', i.item_name, 'quantity', i.quantity, 'unit_price', i.unit_price,
               'discount', i.discount_amount, 'tax', i.tax_amount, 'total', i.line_total)
               order by i.created_at)
             from pos_order_items i where i.order_id = o.id and i.status <> 'voided'), '[]'::jsonb),
           jsonb_build_array(
             jsonb_build_object('label','Subtotal','amount',o.subtotal),
             jsonb_build_object('label','Discount','amount',-o.discount_total),
             jsonb_build_object('label','Service charge','amount',o.service_charge_total),
             jsonb_build_object('label','Tax','amount',o.tax_total),
             jsonb_build_object('label','Total','amount',o.grand_total,'emphasis',true),
             jsonb_build_object('label','Paid','amount',o.paid_total),
             jsonb_build_object('label','Balance','amount',o.grand_total - o.paid_total)),
           jsonb_build_object('Payment status', o.payment_status, 'Guests', o.guest_count)
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from pos_orders o where o.id = _id;

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

  elsif _type = 'folio_statement' then
    select f.organization_id, f.branch_id, f.currency,
           jsonb_build_object('number', f.folio_number, 'date', coalesce(f.closed_at, f.opened_at),
             'status', f.status, 'title', 'Folio statement',
             'subtitle', initcap(replace(f.folio_type,'_',' '))),
           jsonb_build_object('label','Guest','name', coalesce(c.full_name, 'Not configured'),
             'lines', jsonb_build_array(coalesce(c.email,''), coalesce(c.phone,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', coalesce(fl.description, fl.category, fl.line_type),
               'quantity', fl.quantity, 'unit_price', fl.unit_price,
               'discount', fl.discount_amount, 'tax', fl.tax_amount, 'total', fl.net_amount,
               'date', fl.posting_date)
               order by fl.posting_date, fl.created_at)
             from folio_lines fl where fl.folio_id = f.id and fl.status <> 'reversed'), '[]'::jsonb),
           jsonb_build_array(
             jsonb_build_object('label','Charges','amount',f.total_charges),
             jsonb_build_object('label','Discounts','amount',-f.total_discounts),
             jsonb_build_object('label','Taxes','amount',f.total_taxes),
             jsonb_build_object('label','Payments','amount',-f.total_payments),
             jsonb_build_object('label','Refunds','amount',f.total_refunds),
             jsonb_build_object('label','Balance','amount',f.balance,'emphasis',true)),
           '{}'::jsonb
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from folios f
      left join customers c on c.id = f.customer_id
      where f.id = _id;

  elsif _type = 'beo' then
    select b.organization_id, b.branch_id, null,
           jsonb_build_object('number', b.beo_number, 'date', b.start_at, 'status', b.status,
             'title', 'Banquet event order', 'subtitle', 'Revision ' || b.revision::text),
           jsonb_build_object('label','Event','name', coalesce(bk.event_name, 'Not configured'),
             'lines', jsonb_build_array(coalesce(bk.event_reference,''))),
           jsonb_build_array(
             jsonb_build_object('description','Setup', 'note', b.setup_at),
             jsonb_build_object('description','Guest arrival', 'note', b.guest_arrival_at),
             jsonb_build_object('description','Service starts', 'note', b.start_at),
             jsonb_build_object('description','Service ends', 'note', b.end_at),
             jsonb_build_object('description','Breakdown', 'note', b.breakdown_at)),
           '[]'::jsonb,
           jsonb_strip_nulls(jsonb_build_object(
             'Guaranteed guests', b.guaranteed_guests, 'Final guests', b.final_guests,
             'Seating layout', b.seating_layout, 'Menu', b.menu_summary,
             'Beverage service', b.beverage_service, 'Dietary requirements', b.dietary_requirements,
             'Allergies', b.allergies, 'Billing instructions', b.billing_instructions))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from banquet_event_orders b
      left join event_bookings bk on bk.id = b.booking_id
      where b.id = _id;

  elsif _type = 'purchase_order' then
    select p.organization_id, p.branch_id, p.currency,
           jsonb_build_object('number', p.order_number, 'date', coalesce(p.sent_at, p.created_at),
             'status', p.status, 'title', 'Local purchase order',
             'subtitle', case when p.expected_date is null then null else 'Expected ' || p.expected_date::text end),
           jsonb_build_object('label','Supplier','name', coalesce(s.name,'Not configured'),
             'lines', jsonb_build_array(coalesce(s.email,''), coalesce(s.phone,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', coalesce(l.description, si.name), 'quantity', l.quantity,
               'unit', l.unit, 'unit_price', l.unit_price, 'discount', l.discount_amount,
               'tax', l.tax_amount, 'total', l.line_total) order by l.created_at)
             from purchase_order_lines l
             left join stock_items si on si.id = l.stock_item_id
             where l.order_id = p.id), '[]'::jsonb),
           jsonb_build_array(
             jsonb_build_object('label','Subtotal','amount',p.subtotal),
             jsonb_build_object('label','Discount','amount',-coalesce(p.discount_amount,0)),
             jsonb_build_object('label','Tax','amount',p.tax_amount),
             jsonb_build_object('label','Order total','amount',p.total_amount,'emphasis',true)),
           jsonb_strip_nulls(jsonb_build_object('Payment terms', p.payment_terms,
             'Delivery address', p.delivery_address, 'Notes', p.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from purchase_orders p
      left join suppliers s on s.id = p.supplier_id
      where p.id = _id;

  elsif _type = 'goods_receipt' then
    select g.organization_id, g.branch_id, null,
           jsonb_build_object('number', g.grn_number, 'date', coalesce(g.received_at, g.created_at),
             'status', g.status, 'title', 'Goods received note',
             'subtitle', case when p.order_number is null then null else 'Against ' || p.order_number end),
           jsonb_build_object('label','Supplier','name', coalesce(s.name,'Not configured'),
             'lines', jsonb_build_array(coalesce(g.delivery_note_number,''), coalesce(g.supplier_invoice_number,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', si.name, 'quantity', l.quantity_received, 'unit', l.unit,
               'unit_price', l.unit_price,
               'total', round(coalesce(l.quantity_accepted, l.quantity_received) * coalesce(l.unit_price,0), 2),
               'note', nullif(concat_ws(' / ',
                 'ordered ' || coalesce(l.quantity_ordered,0)::text,
                 case when coalesce(l.quantity_rejected,0) > 0 then 'rejected ' || l.quantity_rejected::text end),''))
               order by l.created_at)
             from goods_receipt_lines l
             left join stock_items si on si.id = l.stock_item_id
             where l.receipt_id = g.id), '[]'::jsonb),
           jsonb_build_array(jsonb_build_object('label','Received value','amount',g.total_value,'emphasis',true)),
           jsonb_strip_nulls(jsonb_build_object('Partial delivery', g.is_partial,
             'Discrepancies', g.discrepancy_notes, 'Notes', g.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from goods_receipts g
      left join purchase_orders p on p.id = g.order_id
      left join suppliers s on s.id = g.supplier_id
      where g.id = _id;

  elsif _type = 'requisition' then
    select r.organization_id, r.branch_id, null,
           jsonb_build_object('number', r.request_number, 'date', r.request_date, 'status', r.status,
             'title', 'Store requisition',
             'subtitle', case when r.required_date is null then null else 'Required ' || r.required_date::text end),
           jsonb_build_object('label','Requesting department','name', coalesce(d.name,'Not configured'),
             'lines', jsonb_build_array(coalesce(r.priority,''), coalesce(r.reason,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', coalesce(l.description, si.name), 'quantity', l.quantity_requested,
               'unit', l.unit,
               'note', concat_ws(' / ',
                 'approved ' || coalesce(l.quantity_approved,0)::text,
                 'issued ' || coalesce(l.quantity_issued,0)::text))
               order by l.created_at)
             from internal_requisition_lines l
             left join stock_items si on si.id = l.stock_item_id
             where l.requisition_id = r.id), '[]'::jsonb),
           '[]'::jsonb,
           jsonb_strip_nulls(jsonb_build_object('Shortages', r.shortage_notes, 'Notes', r.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from internal_requisitions r
      left join departments d on d.id = r.department_id
      where r.id = _id;

  elsif _type = 'stock_sheet' then
    select t.organization_id, t.branch_id, null,
           jsonb_build_object('number', t.reference, 'date', coalesce(t.completed_at, t.started_at, t.scheduled_for),
             'status', t.status, 'title', 'Stock count sheet',
             'subtitle', initcap(replace(coalesce(t.count_type,'full'),'_',' ')) || ' count'),
           jsonb_build_object('label','Store location','name', coalesce(l.name,'Not configured'),
             'lines', jsonb_build_array(coalesce(t.notes,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', si.name, 'unit', l2.unit,
               'quantity', l2.counted_quantity,
               'unit_price', l2.unit_cost,
               'total', round(coalesce(l2.variance,0) * coalesce(l2.unit_cost,0), 2),
               'note', 'system ' || coalesce(l2.system_quantity,0)::text || ' / variance ' || coalesce(l2.variance,0)::text)
               order by si.name)
             from stock_take_lines l2
             left join stock_items si on si.id = l2.stock_item_id
             where l2.stock_take_id = t.id), '[]'::jsonb),
           jsonb_build_array(jsonb_build_object('label','Variance value','amount', coalesce(t.variance_value,0),'emphasis',true)),
           jsonb_strip_nulls(jsonb_build_object('Scheduled for', t.scheduled_for, 'Notes', t.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from stock_takes t
      left join stock_locations l on l.id = t.location_id
      where t.id = _id;

  elsif _type = 'staff_schedule' then
    select r.organization_id, r.branch_id, null,
           jsonb_build_object('number', coalesce(r.name, 'Roster'), 'date', coalesce(r.published_at, r.created_at),
             'status', r.status, 'title', 'Staff schedule',
             'subtitle', r.period_start::text || ' to ' || r.period_end::text),
           jsonb_build_object('label','Department','name', coalesce(d.name,'All departments'),
             'lines', jsonb_build_array(coalesce(r.notes,''), 'Version ' || coalesce(r.version,1)::text)),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', coalesce(e.full_name, 'Open shift'),
               'note', concat_ws(' / ',
                 to_char(a.shift_date,'Dy DD Mon'),
                 case when a.starts_at is null then null
                   else to_char(a.starts_at,'HH24:MI') || '-' || coalesce(to_char(a.ends_at,'HH24:MI'),'') end,
                 nullif(a.role_hint,''), nullif(a.status,'')))
               order by a.shift_date, a.starts_at)
             from roster_assignments a
             left join employees e on e.id = a.employee_id
             where a.roster_id = r.id), '[]'::jsonb),
           '[]'::jsonb,
           jsonb_strip_nulls(jsonb_build_object('Period', r.period_start::text || ' – ' || r.period_end::text, 'Notes', r.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from rosters r
      left join departments d on d.id = r.department_id
      where r.id = _id;

  elsif _type = 'task_sheet' then
    select d.organization_id, d.branch_id, null,
           jsonb_build_object('number', to_char(now(),'YYYYMMDD-HH24MI'), 'date', now(),
             'status', 'active', 'title', 'Task sheet',
             'subtitle', coalesce(d.name,'Department') || ' – open work'),
           jsonb_build_object('label','Department','name', coalesce(d.name,'Not configured'),
             'lines', jsonb_build_array(coalesce(d.code,''))),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'description', t.title,
               'note', concat_ws(' / ',
                 nullif(t.reference,''),
                 coalesce(e.full_name, 'Unassigned'),
                 case when t.due_at is null then null else 'due ' || to_char(t.due_at,'DD Mon HH24:MI') end,
                 initcap(replace(coalesce(t.priority,'normal'),'_',' ')),
                 initcap(replace(coalesce(t.status,'open'),'_',' ')))) 
               order by t.due_at nulls last, t.created_at)
             from tasks t
             left join employees e on e.id = t.assignee_id
             where t.department_id = d.id
               and coalesce(t.status,'open') not in ('completed','cancelled')), '[]'::jsonb),
           '[]'::jsonb,
           jsonb_build_object('Generated', to_char(now(),'DD Mon YYYY HH24:MI'))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from departments d
      where d.id = _id;
  end if;

  if _org is null then
    raise exception 'Document not found or not visible in your scope.';
  end if;
  if not public.neo_branch_in_scope(_branch) then
    raise exception 'This document belongs to a property outside your access scope.';
  end if;
  if not (public.has_permission(_module, '*', 'print') or public.has_permission(_module, '*', 'view')) then
    raise exception 'You do not have permission to produce this document.';
  end if;

  select jsonb_build_object(
           'name', b.name, 'code', b.code, 'address', b.address, 'city', b.city,
           'country', b.country, 'phone', b.phone, 'email', b.email,
           'currency', coalesce(_currency, b.currency))
    into _property
    from branches b where b.id = _branch;

  select jsonb_build_object(
           'organisation', coalesce(o.name, o.legal_name),
           'legal_name', o.legal_name,
           'tax_id', nullif(s.regional->>'taxId',''),
           'tax_id_label', coalesce(nullif(s.regional->>'taxIdLabel',''), 'Tax ID'),
           'registration_number', nullif(s.regional->>'registrationNumber',''),
           'website', nullif(s.contact->>'website',''),
           'currency', coalesce(_currency, nullif(s.regional->>'currency',''), 'KES'),
           'brand', coalesce(s.brand, '{}'::jsonb))
    into _identity
    from organizations o
    left join organization_settings s on s.organization_id = o.id
    where o.id = _org;

  return jsonb_build_object(
    'type', _type,
    'document', _doc,
    'party', _party,
    'lines', coalesce(_lines, '[]'::jsonb),
    'totals', coalesce(_totals, '[]'::jsonb),
    'meta', coalesce(_meta, '{}'::jsonb),
    'property', coalesce(_property, '{}'::jsonb),
    'identity', coalesce(_identity, '{}'::jsonb),
    'branch_id', _branch,
    'generated_at', now()
  );
end;

$function$;
