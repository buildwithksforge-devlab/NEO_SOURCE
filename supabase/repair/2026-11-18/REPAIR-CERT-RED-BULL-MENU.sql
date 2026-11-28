-- One confirmed mismatch only. Run in the original Lovable SQL editor.
-- Corrects future menu consumption; existing recipe/stock/sale history is retained.
BEGIN;
DO $repair$
DECLARE r public.recipes; m public.menu_items; s public.stock_items;
  before_value jsonb; after_value jsonb;
BEGIN
  SELECT * INTO r FROM public.recipes
    WHERE id='2198d48b-4216-46a8-b037-0ca7c61dd2fb' FOR UPDATE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
     OR r.branch_id IS DISTINCT FROM '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
     OR r.status IS DISTINCT FROM 'active' OR r.recipe_type IS DISTINCT FROM 'direct_sale'
     OR r.menu_item_id IS DISTINCT FROM '7670b1bc-846e-439b-b13d-af776ddfdb78'::uuid
     OR r.output_stock_item_id IS DISTINCT FROM '249614b3-2e10-431f-bf9f-34f8b6a8e4a5'::uuid
     OR r.yield_quantity IS DISTINCT FROM 1::numeric OR r.yield_unit IS DISTINCT FROM 'pc' THEN
    RAISE EXCEPTION 'CERT Red Bull recipe changed since inspection; no repair applied';
  END IF;
  SELECT * INTO s FROM public.stock_items WHERE id=r.output_stock_item_id FOR UPDATE;
  IF s.id IS NULL OR s.organization_id IS DISTINCT FROM r.organization_id
     OR s.branch_id IS DISTINCT FROM r.branch_id
     OR s.sku IS DISTINCT FROM 'CERT-SCN-REDBULL-250'
     OR s.base_unit IS DISTINCT FROM 'pc' THEN
    RAISE EXCEPTION 'Red Bull stock identity/ownership/unit changed; no repair applied';
  END IF;
  SELECT * INTO m FROM public.menu_items WHERE id=r.menu_item_id FOR UPDATE;
  IF m.id IS NULL OR m.organization_id IS DISTINCT FROM r.organization_id
     OR m.branch_id IS DISTINCT FROM r.branch_id OR m.consumption_mode IS DISTINCT FROM 'direct_stock' THEN
    RAISE EXCEPTION 'Red Bull menu identity/ownership/mode changed; no repair applied';
  END IF;
  IF m.stock_item_id=s.id AND m.stock_quantity_per_sale=1 AND m.stock_unit='pc' THEN RETURN; END IF;
  IF m.stock_item_id IS DISTINCT FROM '65b8f428-107c-5129-950d-6438a903f3a3'::uuid
     OR m.stock_quantity_per_sale IS DISTINCT FROM 1::numeric OR m.stock_unit IS DISTINCT FROM 'pc' THEN
    RAISE EXCEPTION 'Menu no longer has the inspected water mapping; review before changing';
  END IF;
  before_value:=jsonb_build_object('stock_item_id',m.stock_item_id,
    'stock_quantity_per_sale',m.stock_quantity_per_sale,'stock_unit',m.stock_unit);
  UPDATE public.menu_items SET stock_item_id=s.id,stock_quantity_per_sale=1,stock_unit='pc'
    WHERE id=m.id AND organization_id=r.organization_id;
  SELECT jsonb_build_object('stock_item_id',stock_item_id,
    'stock_quantity_per_sale',stock_quantity_per_sale,'stock_unit',stock_unit)
    INTO after_value FROM public.menu_items WHERE id=m.id;
  IF after_value IS DISTINCT FROM jsonb_build_object('stock_item_id',s.id,'stock_quantity_per_sale',1,'stock_unit','pc') THEN
    RAISE EXCEPTION 'Menu mapping update was not confirmed';
  END IF;
  INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,
    record_id,previous_value,new_value,reason)
  VALUES(r.organization_id,r.branch_id,auth.uid(),'Lovable SQL repair ('||current_user||')',
    'repair.cert_redbull_stock_mapping','kitchen',m.id::text,before_value,after_value,
    '18 Nov inspected approved CERT Red Bull recipe pointed to Red Bull stock but its menu pointed to bottled water. Correct future consumption only; no historical movements reposted.');
END $repair$;
COMMIT;
SELECT jsonb_build_object('menu_item_id',m.id,'stock_item_id',m.stock_item_id,
  'stock_quantity_per_sale',m.stock_quantity_per_sale,'stock_unit',m.stock_unit,
  'matches_recipe',m.stock_item_id=r.output_stock_item_id) AS red_bull_repair_result
FROM public.recipes r JOIN public.menu_items m ON m.id=r.menu_item_id
WHERE r.id='2198d48b-4216-46a8-b037-0ca7c61dd2fb';
