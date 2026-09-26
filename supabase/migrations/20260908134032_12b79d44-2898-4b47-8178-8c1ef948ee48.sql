
-- 1. Default store per item group, per property
CREATE TABLE IF NOT EXISTS public.stock_group_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.stock_item_groups(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_group_stores_unique ON public.stock_group_stores(group_id, coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS stock_group_stores_org ON public.stock_group_stores(organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_group_stores TO authenticated;
GRANT ALL ON public.stock_group_stores TO service_role;
ALTER TABLE public.stock_group_stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_group_stores_read" ON public.stock_group_stores;
CREATE POLICY "stock_group_stores_read" ON public.stock_group_stores FOR SELECT TO authenticated
USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "stock_group_stores_write" ON public.stock_group_stores;
CREATE POLICY "stock_group_stores_write" ON public.stock_group_stores FOR ALL TO authenticated
USING (organization_id = public.current_org_id())
WITH CHECK (organization_id = public.current_org_id());

CREATE OR REPLACE FUNCTION public.stock_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS stock_group_stores_touch ON public.stock_group_stores;
CREATE TRIGGER stock_group_stores_touch BEFORE UPDATE ON public.stock_group_stores
FOR EACH ROW EXECUTE FUNCTION public.stock_touch_updated_at();

-- 2. Draft mapping fields on categories
ALTER TABLE public.stock_categories
  ADD COLUMN IF NOT EXISTS proposed_group_id uuid REFERENCES public.stock_item_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_reason text,
  ADD COLUMN IF NOT EXISTS group_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS group_confirmed_by uuid;

-- 3. Standard item groups (idempotent, never overwrites existing names)
CREATE OR REPLACE FUNCTION public.neo_stock_seed_item_groups()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id(); v_count integer := 0; g record;
BEGIN
  PERFORM public.neo_assert_capability('stores','items','edit');
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace in context'; END IF;
  FOR g IN SELECT * FROM (VALUES
      ('Food / Dry Goods','FOOD','food',10),
      ('Beverage','BEV','beverage',20),
      ('Cleaning & Chemicals','CLEAN','cleaning',30),
      ('Linen & Laundry','LINEN','linen',40),
      ('Guest Amenities','AMEN','amenities',50),
      ('Maintenance','MAINT','maintenance',60),
      ('General','GEN','other',70)
    ) AS t(name,code,kind,sort_order)
  LOOP
    INSERT INTO public.stock_item_groups(organization_id,name,code,kind,sort_order,active)
    VALUES (v_org,g.name,g.code,g.kind,g.sort_order,true)
    ON CONFLICT (organization_id,name) DO NOTHING;
    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.neo_stock_seed_item_groups() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_seed_item_groups() TO authenticated, service_role;

-- 4. Draft proposal for unmapped categories (never applied automatically)
CREATE OR REPLACE FUNCTION public.neo_stock_propose_group_mapping()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id(); v_count integer := 0; c record; v_kind text; v_group uuid;
BEGIN
  PERFORM public.neo_assert_capability('stores','items','edit');
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace in context'; END IF;
  FOR c IN SELECT id, name, coalesce(code,'') AS code FROM public.stock_categories
           WHERE organization_id = v_org AND group_id IS NULL
  LOOP
    v_kind := CASE
      WHEN lower(c.name) ~ '(beer|wine|spirit|liquor|alcohol|soda|juice|water|beverage|drink|coffee|tea|bar)' THEN 'beverage'
      WHEN lower(c.name) ~ '(clean|chemical|deterg|sanit|hygien)' THEN 'cleaning'
      WHEN lower(c.name) ~ '(linen|towel|laundry|bedding|uniform)' THEN 'linen'
      WHEN lower(c.name) ~ '(amenit|toiletr|soap|shampoo|guest supply|slipper)' THEN 'amenities'
      WHEN lower(c.name) ~ '(maintenance|spare|tool|plumb|electric|paint|hardware|engineer)' THEN 'maintenance'
      WHEN lower(c.name) ~ '(food|meat|fish|poultry|vegetable|fruit|dairy|grain|cereal|spice|bakery|dry good|grocer|sauce|oil|flour|frozen|pastry|condiment)' THEN 'food'
      ELSE NULL END;
    IF v_kind IS NULL THEN CONTINUE; END IF;
    SELECT id INTO v_group FROM public.stock_item_groups
      WHERE organization_id = v_org AND kind = v_kind AND active ORDER BY sort_order LIMIT 1;
    IF v_group IS NULL THEN CONTINUE; END IF;
    UPDATE public.stock_categories
      SET proposed_group_id = v_group,
          proposed_reason = 'Suggested from the category name — confirm or change before it applies',
          updated_at = now()
      WHERE id = c.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.neo_stock_propose_group_mapping() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_propose_group_mapping() TO authenticated, service_role;

-- 5. Confirm (or clear) one category's group
CREATE OR REPLACE FUNCTION public.neo_stock_confirm_group_mapping(_category uuid, _group uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := public.current_org_id(); v_target uuid;
BEGIN
  PERFORM public.neo_assert_capability('stores','items','edit');
  IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace in context'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_categories WHERE id = _category AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Category does not belong to this workspace';
  END IF;
  v_target := coalesce(_group, (SELECT proposed_group_id FROM public.stock_categories WHERE id = _category));
  IF v_target IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.stock_item_groups WHERE id = v_target AND organization_id = v_org
  ) THEN RAISE EXCEPTION 'Item group does not belong to this workspace'; END IF;
  UPDATE public.stock_categories
    SET group_id = v_target,
        proposed_group_id = NULL,
        proposed_reason = NULL,
        group_confirmed_at = CASE WHEN v_target IS NULL THEN NULL ELSE now() END,
        group_confirmed_by = CASE WHEN v_target IS NULL THEN NULL ELSE auth.uid() END,
        updated_at = now()
    WHERE id = _category;
  RETURN v_target;
END $$;
REVOKE ALL ON FUNCTION public.neo_stock_confirm_group_mapping(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_confirm_group_mapping(uuid,uuid) TO authenticated, service_role;

-- 6. Folios and purchase orders join the one authoritative transaction register
CREATE OR REPLACE FUNCTION public.neo_canonical_source_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j jsonb:=to_jsonb(NEW); m text; ref text; op text; fin text; amt numeric:=0; cur text:='KES'; idem text; jid uuid; blocker text; nxt text; owner text; fs record;
BEGIN
 m:=CASE TG_TABLE_NAME WHEN 'goods_receipts' THEN 'inventory' WHEN 'event_bookings' THEN 'events' WHEN 'internal_requisitions' THEN 'requisition' WHEN 'maintenance_work_orders' THEN 'maintenance' WHEN 'pos_orders' THEN 'pos' WHEN 'supplier_invoices' THEN 'supplier_invoice' WHEN 'supplier_payments' THEN 'supplier_payment' WHEN 'folios' THEN 'folio' WHEN 'purchase_orders' THEN 'procurement' ELSE regexp_replace(TG_TABLE_NAME,'s$','') END;
 ref:=coalesce(j->>'grn_number',j->>'event_reference',j->>'request_number',j->>'work_order_number',j->>'receipt_number',j->>'order_number',j->>'po_number',j->>'folio_number',j->>'confirmation_number',j->>'room_number',j->>'invoice_number',j->>'payment_number',j->>'id');
 op:=coalesce(j->>'status',j->>'order_status',j->>'room_status','pending');
 amt:=coalesce(nullif(j->>'amount','')::numeric,nullif(j->>'grand_total','')::numeric,nullif(j->>'total_amount','')::numeric,nullif(j->>'total_value','')::numeric,nullif(j->>'total_charges','')::numeric,nullif(j->>'balance','')::numeric,0);
 cur:=coalesce(nullif(j->>'currency',''),'KES');
 idem:=coalesce(nullif(j->>'idempotency_key',''),public.neo_canonical_posting_module(m)||':'||(j->>'id'));
 jid:=coalesce(nullif(j->>'posted_journal_id','')::uuid,nullif(j->>'accrual_journal_id','')::uuid,nullif(j->>'journal_id','')::uuid);
 SELECT financial_status,reason,journal_id,receipt_id INTO fs FROM public.financial_states WHERE source_id=(j->>'id')::uuid AND public.neo_canonical_posting_module(source_module)=public.neo_canonical_posting_module(m) ORDER BY updated_at DESC LIMIT 1;
 fin:=fs.financial_status; blocker:=fs.reason; jid:=coalesce(jid,fs.journal_id);
 IF fin IS NULL THEN
  fin:=CASE
   WHEN m='inventory' AND nullif(j->>'accrual_error','') IS NOT NULL THEN 'failed'
   WHEN m='inventory' AND jid IS NOT NULL THEN 'posted'
   WHEN m='inventory' AND lower(op) IN('posted','received','accepted','completed','closed') THEN 'eligible'
   WHEN m='supplier_invoice' AND jid IS NOT NULL THEN 'posted'
   WHEN m='supplier_invoice' AND lower(coalesce(j->>'match_status','')) IN('held','exception','variance','hold') THEN 'blocked'
   WHEN m='supplier_invoice' AND lower(coalesce(j->>'match_status','')) IN('matched','accepted','approved') THEN 'eligible'
   WHEN m IN('payment','supplier_payment') AND jid IS NOT NULL THEN 'posted'
   WHEN m='payment' AND lower(op) NOT IN('void','voided','cancelled','failed','reversed') AND amt>0 THEN 'eligible'
   WHEN m='supplier_payment' AND lower(op) IN('paid','completed','settled') THEN 'eligible'
   WHEN m='pos' AND coalesce(j->>'folio_post_status','')='posted' THEN 'posted'
   WHEN m='pos' AND lower(op) IN('closed','paid','settled','completed') THEN 'eligible'
   WHEN m='folio' AND lower(op) IN('settled','closed') AND coalesce(nullif(j->>'balance','')::numeric,0)=0 THEN 'posted'
   WHEN m='folio' AND lower(op) IN('settled','closed') THEN 'blocked'
   WHEN m='folio' AND lower(op) IN('open','under-review') THEN 'pending'
   ELSE 'pending' END;
 END IF;
 IF m='folio' AND fin='blocked' AND blocker IS NULL THEN blocker:='Folio was closed with an outstanding balance'; END IF;
 nxt:=CASE fin WHEN 'eligible' THEN 'Post to the general ledger' WHEN 'blocked' THEN 'Resolve the blocking rule, then retry' WHEN 'failed' THEN 'Correct the failure and retry safely' WHEN 'pending' THEN 'Complete the current operational stage' ELSE NULL END;
 IF m='procurement' THEN nxt:=CASE WHEN lower(op) IN('closed','cancelled','fully-invoiced') THEN NULL ELSE 'Receive against this order, then invoice' END; END IF;
 owner:=CASE WHEN fin IN('eligible','blocked','failed') THEN 'Finance' WHEN m='inventory' THEN 'Stores' WHEN m='procurement' THEN 'Procurement' WHEN m='folio' THEN 'Front Office' WHEN m='maintenance' THEN 'Maintenance' WHEN m='requisition' THEN 'Requesting department' ELSE 'Operations' END;
 PERFORM public.neo_canonical_transaction_set((j->>'organization_id')::uuid,nullif(j->>'branch_id','')::uuid,m,(j->>'id')::uuid,ref,op,fin,amt,cur,idem,coalesce(nullif(j->>'updated_by','')::uuid,nullif(j->>'created_by','')::uuid,nullif(j->>'received_by','')::uuid,auth.uid()),owner,nxt,blocker,jid,fs.receipt_id,jsonb_strip_nulls(jsonb_build_object('journal_id',jid,'receipt_id',fs.receipt_id)),jsonb_build_object('source_table',TG_TABLE_NAME),coalesce(nullif(j->>'updated_at','')::timestamptz,nullif(j->>'created_at','')::timestamptz,now()));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_canonical_source_sync() FROM PUBLIC,anon,authenticated;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['folios','purchase_orders'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS canonical_state_sync ON public.%I',t);
  EXECUTE format('CREATE TRIGGER canonical_state_sync AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_canonical_source_sync()',t);
 END LOOP;
END $$;
