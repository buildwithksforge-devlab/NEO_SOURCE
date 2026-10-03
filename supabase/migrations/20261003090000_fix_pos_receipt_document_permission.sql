-- NEO-MAW-001
-- POS receipt stabilization.
--
-- This migration patches the currently-installed neo_document_payload()
-- rather than replacing it from an older source migration. That preserves
-- later additions such as payslip support.
--
-- Fixes:
--   1. POS receipt printing uses the canonical pos.receipts.print permission.
--   2. Sales receipts expose the real confirmed POS payment records,
--      including receipt numbers, payment methods, references, tendered cash
--      and change due.
--   3. Split tenders remain separate payments; the order is not incorrectly
--      assigned one arbitrary payment receipt number.
--   4. Other document types retain their existing behaviour.

DO $mig$
DECLARE
  src text;

  old_permission text := $old_permission$
    if not (public.has_permission(_module, '*', 'print') or public.has_permission(_module, '*', 'view')) then
      raise exception 'You do not have permission to produce this document.';
    end if;
$old_permission$;

  new_permission text := $new_permission$
    if _type = 'pos_receipt' then
      if not public.has_permission('pos', 'receipts', 'print') then
        raise exception 'You do not have permission to produce this receipt.';
      end if;
    else
      if not (
        public.has_permission(_module, '*', 'print')
        or public.has_permission(_module, '*', 'view')
      ) then
        raise exception 'You do not have permission to produce this document.';
      end if;
    end if;
$new_permission$;

  old_pos_branch text := $old_pos$
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
$old_pos$;

  new_pos_branch text := $new_pos$
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
               and i.status <> 'voided'
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
                     when nullif(btrim(coalesce(p.receipt_number, '')), '') is not null
                       then ' · ' || p.receipt_number
                     else ''
                   end,
                 'amount', p.amount
               )
               order by coalesce(p.paid_at, p.created_at), p.created_at
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
               'Order', o.order_number,

               'Table',
                 nullif(
                   btrim(
                     coalesce(
                       case
                         when rt.code is not null and rt.name is not null
                           then rt.code || ' · ' || rt.name
                         else coalesce(rt.code, rt.name, '')
                       end,
                       ''
                     )
                   ),
                   ''
                 ),

               'Waiter',
                 nullif(btrim(coalesce(waiter.full_name, '')), ''),

               'Guests',
                 o.guest_count,

               'Payment status',
                 o.payment_status,

               'Payment receipts',
                 nullif((
                   select string_agg(
                     p.receipt_number,
                     ', '
                     order by coalesce(p.paid_at, p.created_at), p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and nullif(btrim(coalesce(p.receipt_number, '')), '') is not null
                 ), ''),

               'Payment references',
                 nullif((
                   select string_agg(
                     initcap(replace(p.method, '-', ' '))
                     || ': '
                     || p.external_reference,
                     ', '
                     order by coalesce(p.paid_at, p.created_at), p.created_at
                   )
                   from pos_payments p
                   where p.order_id = o.id
                     and p.status = 'confirmed'
                     and nullif(btrim(coalesce(p.external_reference, '')), '') is not null
                 ), ''),

               'Cash tendered',
                 nullif((
                   select string_agg(
                     coalesce(p.currency, o.currency, 'KES')
                     || ' '
                     || trim(to_char(p.tendered, 'FM999999999990.00')),
                     ', '
                     order by coalesce(p.paid_at, p.created_at), p.created_at
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
                     || trim(to_char(p.change_due, 'FM999999999990.00')),
                     ', '
                     order by coalesce(p.paid_at, p.created_at), p.created_at
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
                   left join profiles cp on cp.id = p.cashier_id
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
$new_pos$;

BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO src
    FROM pg_proc p
   WHERE p.proname = 'neo_document_payload'
     AND p.pronamespace = 'public'::regnamespace
     AND pg_get_function_identity_arguments(p.oid) = '_type text, _id uuid';

  IF src IS NULL THEN
    RAISE EXCEPTION
      'neo_document_payload(text, uuid) was not found; POS receipt patch aborted.';
  END IF;


  -- ------------------------------------------------------------
  -- 1. POS receipt permission
  -- ------------------------------------------------------------

  IF position(
       'has_permission(''pos'', ''receipts'', ''print'')'
       in src
     ) = 0 THEN

    IF position(old_permission in src) = 0 THEN
      RAISE EXCEPTION
        'Expected neo_document_payload permission block was not found. Migration stopped without changing the function.';
    END IF;

    src := replace(
      src,
      old_permission,
      new_permission
    );
  END IF;


  -- ------------------------------------------------------------
  -- 2. POS sales receipt payload
  -- ------------------------------------------------------------

  IF position(
       '''Payment receipts'''
       in src
     ) = 0 THEN

    IF position(old_pos_branch in src) = 0 THEN
      RAISE EXCEPTION
        'Expected POS receipt payload branch was not found. Migration stopped without changing the function.';
    END IF;

    src := replace(
      src,
      old_pos_branch,
      new_pos_branch
    );
  END IF;


  -- Apply the patched current function definition.
  EXECUTE src;
END
$mig$;


-- neo_document_payload is business-document infrastructure.
-- Anonymous/public users must never execute it directly.
REVOKE ALL
  ON FUNCTION public.neo_document_payload(text, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE
  ON FUNCTION public.neo_document_payload(text, uuid)
  TO authenticated, service_role;