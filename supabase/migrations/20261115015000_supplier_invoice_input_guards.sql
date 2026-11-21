-- Future supplier-invoice input guards only. Does not capture or approve an invoice.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=to_regprocedure('public.neo_supplier_invoice_capture(jsonb)')
   AND owner.rolname NOT IN ('anon','authenticated') AND (md5(pg_get_functiondef(p.oid))='758c1b024238b1082ecd2cac3dce2a15' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='54449f612b0a24c41bdb2edf548c9603')) THEN
  RAISE EXCEPTION 'Supplier invoice command differs from reviewed installed code; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_supplier_capture_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_supplier_invoice_capture(jsonb)'::regprocedure;
CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_capture(_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_supplier uuid := NULLIF(_payload->>'supplier_id','')::uuid;
  v_number text := btrim(COALESCE(_payload->>'invoice_number',''));
  v_id uuid; ln jsonb; i integer := 0;
  v_net numeric := 0; v_tax numeric := 0; v_total numeric := 0;
  v_q numeric; v_p numeric; v_lt numeric; v_ltax numeric; v_discount numeric;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT coalesce(has_permission('finance','edit') OR is_org_admin(),false) THEN
    RAISE EXCEPTION 'Not permitted to capture supplier invoices';
  END IF;
  IF v_supplier IS NULL THEN RAISE EXCEPTION 'Supplier is required'; END IF;
  IF v_number = '' THEN RAISE EXCEPTION 'Supplier invoice number is required'; END IF;
  IF auth.uid() IS NULL OR public.neo_branch_in_scope(v_branch) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice property is outside your access' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(_payload->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Supplier invoice requires an object with invoice lines'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.suppliers s WHERE s.id=v_supplier AND s.organization_id=v_org AND s.active AND (s.branch_id IS NULL OR s.branch_id=v_branch)) THEN RAISE EXCEPTION 'Supplier is not available in this workspace and property'; END IF;
  IF nullif(_payload->>'currency','') IS NOT NULL AND _payload->>'currency' IS DISTINCT FROM public.neo_fact_currency(v_org,v_branch) THEN RAISE EXCEPTION 'Invoice currency requires verified conversion to this property currency'; END IF;
  IF nullif(_payload->>'order_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_orders po
    WHERE po.id=(_payload->>'order_id')::uuid AND po.organization_id=v_org AND po.branch_id IS NOT DISTINCT FROM v_branch AND po.supplier_id=v_supplier
      AND po.currency=public.neo_fact_currency(v_org,v_branch)) THEN RAISE EXCEPTION 'Purchase order supplier, property or currency does not match this invoice'; END IF;
  IF nullif(_payload->>'receipt_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.goods_receipts gr
    WHERE gr.id=(_payload->>'receipt_id')::uuid AND gr.organization_id=v_org AND gr.branch_id IS NOT DISTINCT FROM v_branch AND gr.supplier_id=v_supplier
      AND (nullif(_payload->>'order_id','') IS NULL OR gr.order_id=(_payload->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Goods receipt does not match this invoice supplier, property or order'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier-invoice:'||v_org::text||':'||v_supplier::text||':'||lower(v_number),0));

  IF COALESCE((_payload->>'allow_duplicate')::boolean, false) = false
     AND EXISTS (SELECT 1 FROM supplier_invoices si
                  WHERE si.organization_id = v_org AND si.supplier_id = v_supplier
                    AND lower(btrim(si.invoice_number)) = lower(v_number)) THEN
    RAISE EXCEPTION 'Invoice % already captured for this supplier', v_number;
  END IF;

  INSERT INTO supplier_invoices (organization_id, branch_id, supplier_id, order_id, receipt_id,
    invoice_number, invoice_date, due_date, amount, tax_amount, status, match_status, notes, created_by)
  VALUES (v_org, v_branch, v_supplier,
    NULLIF(_payload->>'order_id','')::uuid,
    NULLIF(_payload->>'receipt_id','')::uuid,
    v_number,
    COALESCE(NULLIF(_payload->>'invoice_date','')::date, CURRENT_DATE),
    NULLIF(_payload->>'due_date','')::date,
    0, 0, 'draft', 'pending', NULLIF(_payload->>'notes',''), auth.uid())
  RETURNING id INTO v_id;

  FOR ln IN SELECT * FROM jsonb_array_elements(COALESCE(_payload->'lines','[]'::jsonb)) LOOP
    i := i + 1;
    v_q := COALESCE((ln->>'quantity')::numeric, 0);
    v_p := COALESCE((ln->>'unit_price')::numeric, 0);
    v_discount:=COALESCE((ln->>'discount_amount')::numeric,0);
    IF jsonb_typeof(ln) IS DISTINCT FROM 'object' OR v_q<=0 OR v_p<0 OR v_discount<0
      OR v_q::text IN ('NaN','Infinity','-Infinity') OR v_p::text IN ('NaN','Infinity','-Infinity')
      OR v_discount::text IN ('NaN','Infinity','-Infinity') OR v_discount<>round(v_discount,2)
      OR v_discount>round(v_q*v_p,2) THEN RAISE EXCEPTION 'Invoice line % requires finite positive quantity, nonnegative price and a valid currency discount',i; END IF;
    IF nullif(ln->>'stock_item_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_items si WHERE si.id=(ln->>'stock_item_id')::uuid AND si.organization_id=v_org AND (si.branch_id IS NULL OR si.branch_id=v_branch)) THEN RAISE EXCEPTION 'Invoice line % stock item is outside this workspace or property',i; END IF;
    IF nullif(ln->>'expense_account_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chart_of_accounts a WHERE a.id=(ln->>'expense_account_id')::uuid AND a.organization_id=v_org AND a.active AND a.postable AND NOT coalesce(a.is_header,false)) THEN RAISE EXCEPTION 'Invoice line % expense account is not postable in this workspace',i; END IF;
    IF nullif(ln->>'department_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.departments d WHERE d.id=(ln->>'department_id')::uuid AND d.organization_id=v_org AND (d.branch_id IS NULL OR d.branch_id=v_branch)) THEN RAISE EXCEPTION 'Invoice line % department is outside this workspace or property',i; END IF;
    v_lt := round(v_q*v_p-v_discount,2);
    v_ltax := COALESCE((ln->>'tax_amount')::numeric,0);
    IF v_ltax<0 OR v_ltax::text IN ('NaN','Infinity','-Infinity') OR v_ltax<>round(v_ltax,2) THEN RAISE EXCEPTION 'Invoice line % tax must be finite nonnegative currency cents',i; END IF;
    INSERT INTO supplier_invoice_lines (organization_id, supplier_invoice_id, line_number, description,
      stock_item_id, expense_account_id, department_id, quantity, unit_price, tax_amount, net_amount, total_amount)
    VALUES (v_org, v_id, i, NULLIF(ln->>'description',''),
      NULLIF(ln->>'stock_item_id','')::uuid,
      NULLIF(ln->>'expense_account_id','')::uuid,
      NULLIF(ln->>'department_id','')::uuid,
      v_q, v_p, v_ltax, v_lt, v_lt + v_ltax);
    v_net := v_net + v_lt; v_tax := v_tax + v_ltax;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'At least one invoice line is required'; END IF;
  v_total := round(v_net + v_tax, 2);

  UPDATE supplier_invoices SET amount = v_total, tax_amount = round(v_tax,2) WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_id, 'amount', v_total,
    'match', public.proc_three_way_match(v_id));
END $function$
;

DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN neo_supplier_capture_acl saved ON saved.proowner=p.proowner AND saved.acl=coalesce(p.proacl::text,'')
   WHERE p.oid='public.neo_supplier_invoice_capture(jsonb)'::regprocedure AND p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public']
   AND p.prorettype='jsonb'::regtype AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='54449f612b0a24c41bdb2edf548c9603') THEN
  RAISE EXCEPTION 'Supplier capture definition or permissions verification failed; installation rolled back';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','supplier-invoice-input-guards-v1','definition_matches',true,'permissions_unchanged',true,
 'scope','Validates future supplier invoice amounts and source workspace/property links; serializes duplicate checks. Installation captures or approves no invoice and changes no historical amount or permission.');
COMMIT;
