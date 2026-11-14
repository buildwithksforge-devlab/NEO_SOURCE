CREATE FUNCTION public.neo_pos_can_print_receipt(_order uuid,_reprint boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE o public.pos_orders; existing_authority boolean;
BEGIN
 IF auth.uid() IS NULL OR public.current_org_id() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RETURN false; END IF;
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=public.current_org_id();
 IF o.id IS NULL OR o.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) THEN RETURN false; END IF;
 existing_authority:=coalesce(public.is_org_admin_for(o.organization_id) OR public.has_permission('pos','settings.manage') OR public.has_permission('pos',CASE WHEN _reprint THEN 'receipts.reprint' ELSE 'receipts.print' END),false);
 IF existing_authority THEN RETURN true; END IF;
 -- Creating orders includes a first receipt for an order within the waiter's normal scope.
 RETURN NOT coalesce(_reprint,true) AND coalesce(public.has_permission('restaurant','orders.create'),false)
  AND coalesce(public.in_my_scope(o.organization_id,o.branch_id,o.department_id,o.station_id,o.waiter_id,o.created_by) OR public.is_shared_with_me('pos_order',o.id),false);
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_can_print_receipt(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_can_print_receipt(uuid,boolean) TO authenticated,service_role;
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
    when 'payslip' then 'human-resources'
    else null end;
  if _module is null then
    raise exception 'Unknown document type: %', _type;
  end if;

  
if _type = 'pos_receipt' then
    select
           o.organization_id,
           o.branch_id,
           o.currency,

           jsonb_build_object(
             'number', o.order_number,
             'date', coalesce(o.closed_at, o.created_at),
             'status', o.status,
             'title', 'Sales receipt',
             'subtitle', initcap(replace(o.order_type,'_',' '))
           ),

           jsonb_build_object(
             'label', 'Billed to',
             'name', coalesce(o.guest_name, c.full_name, 'Walk-in guest'),
             'lines', jsonb_build_array(
               coalesce(o.contact_phone, c.phone, '')
             )
           ),

           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'description', i.item_name,
                 'quantity', i.quantity,
                 'unit_price', i.unit_price,
                 'discount', i.discount_amount,
                 'tax', i.tax_amount,
                 'total', i.line_total
               )
               order by i.created_at
             )
             from pos_order_items i
             where i.order_id = o.id
               and i.status NOT IN ('voided','cancelled')
           ), '[]'::jsonb),

           jsonb_build_array(
             jsonb_build_object(
               'label', 'Subtotal',
               'amount', o.subtotal
             ),
             jsonb_build_object(
               'label', 'Discount',
               'amount', -o.discount_total
             ),
             jsonb_build_object(
               'label', 'Service charge',
               'amount', o.service_charge_total
             ),
             jsonb_build_object(
               'label', 'Tax',
               'amount', o.tax_total
             ),
             jsonb_build_object(
               'label', 'Total',
               'amount', o.grand_total,
               'emphasis', true
             )
           )

           ||

           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'label',
                   initcap(replace(p.method, '-', ' '))
                   ||
                   case
                     when nullif(
                       btrim(coalesce(p.receipt_number, '')),
                       ''
                     ) is not null
                     then ' · ' || p.receipt_number
                     else ''
                   end,
                 'amount', p.amount
               )
               order by
                 coalesce(p.paid_at, p.created_at),
                 p.created_at
             )
             from pos_payments p
             where p.order_id = o.id
               and p.status = 'confirmed'
           ), '[]'::jsonb)

           ||

           jsonb_build_array(
             jsonb_build_object(
               'label', 'Paid',
               'amount', o.paid_total
             ),
             jsonb_build_object(
               'label', 'Balance',
               'amount', o.grand_total - o.paid_total
             )
           ),

           jsonb_strip_nulls(
             jsonb_build_object(
               'Order',
                 o.order_number,

               'Table',
                 nullif(
                   btrim(
                     coalesce(
                       case
                         when rt.code is not null
                              and rt.name is not null
                         then rt.code || ' · ' || rt.name
                         else coalesce(rt.code, rt.name, '')
                       end,
                       ''
                     )
                   ),
                   ''
                 ),

               'Waiter',
                 nullif(
                   btrim(coalesce(waiter.full_name, '')),
                   ''
                 ),

               'Guests',
                 o.guest_count,

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
                 nullif((
                   select string_agg(
                     p.receipt_number,
                     ', '
                     order by
                       coalesce(p.paid_at, p.created_at),
                       p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and nullif(
                       btrim(coalesce(p.receipt_number, '')),
                       ''
                     ) is not null
                 ), ''),

               'Payment references',
                 nullif((
                   select string_agg(
                     initcap(replace(p.method, '-', ' '))
                     || ': '
                     || p.external_reference,
                     ', '
                     order by
                       coalesce(p.paid_at, p.created_at),
                       p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and nullif(
                       btrim(coalesce(p.external_reference, '')),
                       ''
                     ) is not null
                 ), ''),

               'Cash tendered',
                 nullif((
                   select string_agg(
                     coalesce(p.currency, o.currency, 'KES')
                     || ' '
                     || trim(
                       to_char(
                         p.tendered,
                         'FM999999999990.00'
                       )
                     ),
                     ', '
                     order by
                       coalesce(p.paid_at, p.created_at),
                       p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and p.method = 'cash'
                     and p.tendered is not null
                 ), ''),

               'Change due',
                 nullif((
                   select string_agg(
                     coalesce(p.currency, o.currency, 'KES')
                     || ' '
                     || trim(
                       to_char(
                         p.change_due,
                         'FM999999999990.00'
                       )
                     ),
                     ', '
                     order by
                       coalesce(p.paid_at, p.created_at),
                       p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and p.method = 'cash'
                     and coalesce(p.change_due, 0) > 0
                 ), ''),

               'Collected by',
                 nullif((
                   select string_agg(
                     distinct coalesce(cp.full_name, 'Staff'),
                     ', '
                   )
                   from pos_payments p
                   left join profiles cp
                     on cp.id = p.cashier_id
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                 ), '')
             )
           )

      into
           _org,
           _branch,
           _currency,
           _doc,
           _party,
           _lines,
           _totals,
           _meta

      from pos_orders o

      left join customers c
        on c.id = o.customer_id

      left join restaurant_tables rt
        on rt.id = o.table_id

      left join profiles waiter
        on waiter.id = o.waiter_id

      where o.id = _id;

  
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
           jsonb_strip_nulls(jsonb_build_object('Period', r.period_start::text || ' - ' || r.period_end::text, 'Notes', r.notes))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from rosters r
      left join departments d on d.id = r.department_id
      where r.id = _id;

  elsif _type = 'payslip' then
    select p.organization_id, coalesce(p.branch_id, e.branch_id, per.branch_id), coalesce(p.currency, 'KES'),
           jsonb_build_object(
             'number', coalesce(e.employee_number, left(p.id::text, 8)),
             'date', per.period_end,
             'status', case when per.payslips_released_at is null then 'withheld' else 'released' end,
             'title', 'Payslip',
             'subtitle', per.name),
           jsonb_build_object('label', 'Employee', 'name', coalesce(e.full_name, 'Not configured'),
             'lines', jsonb_build_array(coalesce(e.job_title, ''), coalesce(e.employee_number, ''))),
           '[]'::jsonb,
           jsonb_build_array(
             jsonb_build_object('label', 'Basic pay', 'amount', p.base_pay),
             jsonb_build_object('label', 'Allowances', 'amount', p.allowances),
             jsonb_build_object('label', 'Bonuses', 'amount', p.bonuses),
             jsonb_build_object('label', 'Commissions', 'amount', p.commissions),
             jsonb_build_object('label', 'Reimbursements', 'amount', p.reimbursements),
             jsonb_build_object('label', 'Gross pay', 'amount', p.gross_pay, 'emphasis', true),
             jsonb_build_object('label', 'Deductions', 'amount', -p.deductions),
             jsonb_build_object('label', 'Net pay', 'amount', p.net_pay, 'emphasis', true)),
           jsonb_strip_nulls(jsonb_build_object(
             'Period', per.period_start::text || ' - ' || per.period_end::text,
             'Days worked', p.worked_days,
             'Hours worked', p.worked_hours,
             'Overtime hours', p.overtime_hours,
             'Paid leave days', p.paid_leave_days,
             'Unpaid leave days', p.unpaid_leave_days,
             'Notes', nullif(p.notes, '')))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from payroll_input_records p
      join payroll_periods per on per.id = p.period_id
      left join employees e on e.id = p.employee_id
      where p.id = _id;

  elsif _type = 'task_sheet' then
    select d.organization_id, d.branch_id, null,
           jsonb_build_object('number', to_char(now(),'YYYYMMDD-HH24MI'), 'date', now(),
             'status', 'active', 'title', 'Task sheet',
             'subtitle', coalesce(d.name,'Department') || ' open work'),
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
  -- A property scope helper is not a tenant boundary for organization-wide users.
  if public.current_org_id() is null or _org is distinct from public.current_org_id() then
    raise exception 'Document not found or not visible in your scope.' using errcode = '42501';
  end if;
  if not public.neo_branch_in_scope(_branch) then
    raise exception 'This document belongs to a property outside your access scope.';
  end if;
  
if _type = 'pos_receipt' then
    if not public.neo_pos_can_print_receipt(_id,false) then
      raise exception
        'You do not have permission to produce this receipt.';
    end if;
  else
    if not (
      public.has_permission(_module, '*', 'print')
      or public.has_permission(_module, '*', 'view')
    ) then
      raise exception
        'You do not have permission to produce this document.';
    end if;
  end if;
  

  select jsonb_build_object(
           'name', b.name, 'code', b.code, 'address', b.address, 'city', b.city,
           'country', b.country, 'phone', b.phone, 'email', b.email,
           'currency', coalesce(_currency, b.currency), 'timezone', b.timezone)
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

CREATE OR REPLACE FUNCTION public.neo_print_enqueue(_printer uuid, _document_type text, _title text DEFAULT NULL::text, _payload jsonb DEFAULT '{}'::jsonb, _idempotency text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.printer_profiles;
  j uuid;

  v_order_id uuid;
  v_order_text text;
  v_order_org uuid;
  v_order_branch uuid;

  v_is_duplicate boolean := false;
BEGIN
  SELECT *
  INTO p
  FROM public.printer_profiles
  WHERE id = _printer;

  IF p.id IS NULL THEN
    RAISE EXCEPTION 'Printer not found';
  END IF;

  IF p.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'Printer belongs to another workspace';
  END IF;

  /*
   * POS RECEIPTS
   *
   * First successful physical print:
   *   pos.receipts.print
   *
   * Any new print after a successful physical print:
   *   pos.receipts.reprint
   *
   * Failed attempts and retries of the same job are not reprints.
   */
  IF _document_type = 'pos_receipt' THEN

    v_order_text :=
      NULLIF(
        BTRIM(
          COALESCE(
            _payload ->> 'document_id',
            _payload ->> 'order_id',
            ''
          )
        ),
        ''
      );

    IF v_order_text IS NULL THEN
      RAISE EXCEPTION 'POS receipt print requires an order id';
    END IF;

    BEGIN
      v_order_id := v_order_text::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Invalid POS order id';
    END;

    SELECT
      o.organization_id,
      o.branch_id
    INTO
      v_order_org,
      v_order_branch
    FROM public.pos_orders o
    WHERE o.id = v_order_id;

    IF v_order_org IS NULL THEN
      RAISE EXCEPTION 'POS order not found';
    END IF;

    IF v_order_org <> p.organization_id THEN
      RAISE EXCEPTION 'POS order belongs to another workspace';
    END IF;

    IF NOT public.neo_branch_in_scope(v_order_branch) THEN
      RAISE EXCEPTION 'POS order belongs to a property outside your access scope';
    END IF;

    IF NOT public.neo_pos_can_print_receipt(v_order_id,false) THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
    IF NOT coalesce(p.active,false) OR p.branch_id IS DISTINCT FROM v_order_branch THEN RAISE EXCEPTION 'Printer must be active at the order property'; END IF;
    IF _idempotency IS NOT NULL THEN
      SELECT pj.id INTO j FROM public.print_jobs pj WHERE pj.organization_id=p.organization_id AND pj.idempotency_key=_idempotency AND pj.order_id=v_order_id AND pj.printer_id=p.id AND pj.document_type=_document_type;
      IF j IS NOT NULL THEN RETURN j; END IF;
      IF EXISTS(SELECT 1 FROM public.print_jobs pj WHERE pj.organization_id=p.organization_id AND pj.idempotency_key=_idempotency) THEN RAISE EXCEPTION 'Print request identity belongs to different work'; END IF;
    END IF;

    /*
     * Serialize print creation for this order so two fast clicks cannot both
     * create independent "first print" jobs.
     */
    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_order_id::text, 0)
    );

    /*
     * If the first print is already queued, return that same job rather than
     * creating another physical copy.
     */
    SELECT pj.id
    INTO j
    FROM public.print_jobs pj
    WHERE pj.organization_id = p.organization_id
      AND pj.order_id = v_order_id
      AND pj.document_type = 'pos_receipt'
      AND pj.status IN ('queued','printing')
    ORDER BY pj.created_at DESC
    LIMIT 1;

    IF j IS NOT NULL THEN
      RETURN j;
    END IF;

    /*
     * A receipt becomes a reprint only after a previous physical print was
     * explicitly confirmed successful.
     */
    SELECT EXISTS (
      SELECT 1
      FROM public.print_jobs pj
      WHERE pj.organization_id = p.organization_id
        AND pj.order_id = v_order_id
        AND pj.document_type = 'pos_receipt'
        AND ((pj.status = 'completed' AND pj.completed_at IS NOT NULL) OR (pj.status='failed' AND coalesce(pj.last_error,'') ILIKE '%unknown%'))
    )
    INTO v_is_duplicate;

    IF NOT public.neo_pos_can_print_receipt(v_order_id,v_is_duplicate) THEN
      IF v_is_duplicate THEN RAISE EXCEPTION 'receipt_reprint_permission_required'; ELSE RAISE EXCEPTION 'permission_denied'; END IF;
    END IF;

  ELSE

    /*
     * Preserve the existing authorization behaviour for non-POS documents.
     * Their permission model is outside this POS receipt repair.
     */
    IF NOT (
      public.has_permission('pos', 'receipts.print')
      OR public.has_permission('pos', 'settings.manage')
      OR public.is_org_admin_for(p.organization_id)
    ) THEN
      RAISE EXCEPTION 'permission_denied';
    END IF;

  END IF;

  INSERT INTO public.print_jobs (
    organization_id,
    branch_id,
    printer_id,
    original_printer_id,
    order_id,
    document_type,
    is_duplicate,
    title,
    payload,
    status,
    max_attempts,
    idempotency_key,
    created_by
  )
  VALUES (
    p.organization_id,
    CASE
      WHEN _document_type = 'pos_receipt'
        THEN v_order_branch
      ELSE p.branch_id
    END,
    p.id,
    p.id,
    v_order_id,
    _document_type,
    v_is_duplicate,
    _title,
    CASE WHEN _document_type='pos_receipt' THEN jsonb_build_object('document',public.neo_document_payload('pos_receipt',v_order_id)) ELSE COALESCE(_payload, '{}'::jsonb) END,
    'queued',
    GREATEST(1, COALESCE(p.retry_limit, 3)),
    _idempotency,
    auth.uid()
  )
  RETURNING id INTO j;

  RETURN j;
END;
$function$;
