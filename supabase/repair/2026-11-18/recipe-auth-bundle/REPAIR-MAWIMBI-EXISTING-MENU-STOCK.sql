-- Reviewed Mawimbi-owned stock: update 21 EXISTING menu rows only.
-- No stock/menu/recipe creation, no stock quantity movement, no history rewrite.
-- Variant choices authorized by user on 18 Nov; exact product names shown on menu.
BEGIN;
CREATE TEMP TABLE neo_mawimbi_map(
  recipe_id uuid,menu_item_id uuid,old_recipe_stock_id uuid,old_menu_stock_id uuid,
  old_unit text,new_stock_id uuid,new_name text,new_unit text
) ON COMMIT DROP;
INSERT INTO neo_mawimbi_map VALUES
    ('f881609f-cec3-408e-89a3-9aeefd3fd434','196b4b7b-bc3e-4c28-a01b-0da8c8ec7014','9767ab3a-3626-4877-a539-b085ff92f657','9767ab3a-3626-4877-a539-b085ff92f657','bottle','5138ac85-dea8-4dc6-b8ce-527e2ddf4591','Swartland Winery 750ml','Bottle'),
    ('fe342c04-e248-47c0-8019-f33826aa4219','1989c450-5c8b-4f42-a6b4-d03c9676a5a4','a7800b57-cd71-4b2b-aba3-4e39335f6bef','a7800b57-cd71-4b2b-aba3-4e39335f6bef','bottle','fee704e5-08ea-463f-bcb8-ad54de964b6a','Tusker Lager 500ml','Bottle'),
    ('163cca5a-7ecf-40a1-8b04-b17b90d0ed89','28ce038d-f75c-413e-a4f3-ae4f950a2b25','007dc61b-8325-4c64-8b1f-e5e72e9e6816','007dc61b-8325-4c64-8b1f-e5e72e9e6816','bottle','6b92918c-9e26-4b3f-9624-f0f3e431b549','Monkey Shoulder 750ml','Bottle'),
    ('bc9c22dd-7d54-456f-95b1-2c98861e81c2','2998e7da-e669-4c7e-bf85-29e904d65af6','28edf882-37ab-472e-9e3c-e2f6625b9893','28edf882-37ab-472e-9e3c-e2f6625b9893','bottle','67c09315-f3c6-41e3-8add-728d3fbb971b','Heineken 330ml','Bottle'),
    ('628faf86-65b7-4148-adc6-43628f811ce9','637f9d93-1c01-407f-8e46-0e78f7d78d72','9bda80f3-3f5d-4476-8b8c-dbb725a69d41','9bda80f3-3f5d-4476-8b8c-dbb725a69d41','bottle','fa9abaef-0a48-4e42-ba5f-f688074d9530','Camino Silver 750ml','Bottle'),
    ('cf3800df-f76f-43ca-84b4-88ce388d6150','7b3a585d-a61d-44ed-b436-e8713ecdc7f9','259295bd-2c90-4bcb-9352-38cad68c4897','259295bd-2c90-4bcb-9352-38cad68c4897','bottle','c06151d9-ab22-438e-83e0-6f7c886d7aac','Amarula 750ml','Bottle'),
    ('624664dd-06be-4b4e-b770-8dfe51611dbd','7b806f6d-5eb1-4729-8327-d36d243cdfa1','890f8409-b562-4ba2-bd4d-524528809bbb','890f8409-b562-4ba2-bd4d-524528809bbb','pc','bdd8e9eb-4212-4a94-b31d-d773af77acbb','Red Bull','Can'),
    ('a4a4aa48-fb75-4a15-88d6-0d0302c9e2dd','88a963a5-a8a1-4141-9ae9-060e2cbc00b2','9f0c6114-c35d-4423-909d-6a9d33291b87','9f0c6114-c35d-4423-909d-6a9d33291b87','bottle','4831341c-a710-4ed0-b68f-1c2fc73c33bc','Jameson Triple Distilled 750ml','Bottle'),
    ('52588174-1154-4177-a944-e16723958b8b','8ffc9ee2-6528-4c0c-8205-dff57c4b3bd8','46e8deae-6ff4-4949-b3e8-52316cfe6bb8','46e8deae-6ff4-4949-b3e8-52316cfe6bb8','bottle','58104314-0862-465c-9740-ac8b275a9630','Jose Cuervo Gold 750ml','Bottle'),
    ('75889855-3e96-4903-8e8d-1dfac447a3e7','9428c851-d43e-4b32-b482-8b9d0a8ef6c0','b20f4d86-9dd0-477d-864c-7dbe15d9ff32','b20f4d86-9dd0-477d-864c-7dbe15d9ff32','bottle','debdff10-1baa-4075-8398-2bb2ff663bf5','Captain Morgan 750ml','Bottle'),
    ('687eeb7e-e869-461a-9353-2c565e959dfd','94935aec-39c8-4f4c-a1c2-87e0fb260088','45bf455c-b8de-488a-bdcd-2a78976c98f5','a6f94677-0d1d-4a40-a6e0-b42a9f9c1f33','bottle','0240370a-1fd5-4609-9167-aa7d1b7d0e27','Beefeater Original Gin 750ml','Bottle'),
    ('83f2f8a3-16ce-42bb-a758-48ca3f67a486','a7ef8428-5b65-41ad-9508-05c7fb4dc4f1','6b9e050b-b9cf-4a72-919d-d79b079ec8a6','6b9e050b-b9cf-4a72-919d-d79b079ec8a6','bottle','8e5bd0e6-0c12-46dc-819f-79c82c27e9ed','Water 500 ml','Bottle'),
    ('b0cf5235-3dd4-4227-9a28-46cdbc2c10a0','a90e2b26-4969-4087-a292-38de83eb0062','890f8409-b562-4ba2-bd4d-524528809bbb','890f8409-b562-4ba2-bd4d-524528809bbb','pc','bdd8e9eb-4212-4a94-b31d-d773af77acbb','Red Bull','Can'),
    ('f13b2f87-284f-452f-ada3-70ea5d2a2a24','af98b5d1-e230-41fb-9320-7774b9a7b284','43f250b0-88d5-4abf-9596-0a3b38a7226e','43f250b0-88d5-4abf-9596-0a3b38a7226e','bottle','3da9cc84-61cf-443a-ac65-bc604299a0e3','Robertson Sweet Red 750ml','Bottle'),
    ('5eaaa882-e75e-4d53-ac71-0c34904365ed','d000305a-0f44-4b71-98ba-e1a91827486a','d77d1090-16f4-496b-8ba9-3369339b2058','d77d1090-16f4-496b-8ba9-3369339b2058','bottle','ff539603-f660-4d20-a9bb-d391ae6a80c8','Versus Sensation Red 750ml','Bottle'),
    ('3973bb30-6ccc-4a99-8985-4cbfb1093870','d17f9ce1-b9f6-48fa-a241-82020c928776','236d7946-7fda-4455-95ee-8f6633337bae','236d7946-7fda-4455-95ee-8f6633337bae','bottle','430c56c2-e585-488e-bac6-01b842dde5c9','Jägermeister 700ml','Bottle'),
    ('e3f02cc5-3e3e-4de6-8b36-163e66eb4a63','d87f1c61-1769-4f0c-97a0-e77aa049e8e7','8173f72a-a847-4546-86cb-957e108d051a','8173f72a-a847-4546-86cb-957e108d051a','bottle','df2382f0-759e-495b-a62d-750f66a96f7c','Moët & Chandon 750ml','Bottle'),
    ('a636141b-3b95-4eb2-981b-4df46d47df63','dafdf54b-eb87-4cd7-a5d0-5f1b9e5baafb','a3a25ee7-3cc5-4473-8de6-ce8d0a02589b','a3a25ee7-3cc5-4473-8de6-ce8d0a02589b','bottle','0d55a221-318f-4b8b-951b-21b291ec446e','Hennessy VS 750ml','Bottle'),
    ('c09e3a70-0e20-491f-bf1c-ad8cb0dee0cd','db209b05-d157-40fc-b55e-b3ba57973f33','a3bd581d-70d8-484b-9db0-e097b552a702','a3bd581d-70d8-484b-9db0-e097b552a702','bottle','138ad1e1-04d1-45a1-9fbc-5e81df619aa8','Malibu Rum Coconut 700ml','Bottle'),
    ('ce114a6f-dd7a-4eee-bec7-d28ca8a91afb','ea10ec95-1b74-41ff-b466-56836bef440a','6b9e050b-b9cf-4a72-919d-d79b079ec8a6','6b9e050b-b9cf-4a72-919d-d79b079ec8a6','bottle','8e5bd0e6-0c12-46dc-819f-79c82c27e9ed','Water 500 ml','Bottle'),
    ('e1539d86-8a6f-4c60-8269-60070b835b29','fb2ed640-1d4b-40f7-a601-7c29101ffd98','bc31cf26-7ced-4a19-afd8-372646b3eb4a','bc31cf26-7ced-4a19-afd8-372646b3eb4a','bottle','ca6de890-a1f0-4944-a645-dc3d06f8ee52','Johnnie Walker Black Label 750ml','Bottle');
CREATE TEMP TABLE neo_mawimbi_recipe_before ON COMMIT DROP AS
  SELECT r.id,to_jsonb(r) AS snapshot FROM public.recipes r
  JOIN neo_mawimbi_map map ON map.recipe_id=r.id;
DO $repair$
DECLARE entry record; r public.recipes; m public.menu_items; s public.stock_items;
  old_value jsonb; new_value jsonb;
BEGIN
  FOR entry IN SELECT * FROM neo_mawimbi_map ORDER BY menu_item_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('recipe-activation:c10e5d20-dc04-4959-9db4-4c2afb9d2f8c:'||entry.menu_item_id::text,19));
    SELECT * INTO r FROM public.recipes WHERE id=entry.recipe_id FOR UPDATE;
    IF r.id IS NULL OR r.organization_id IS DISTINCT FROM 'c10e5d20-dc04-4959-9db4-4c2afb9d2f8c'::uuid
      OR r.branch_id IS DISTINCT FROM 'c6169bc5-2123-4f2e-a660-c2aa81b83df2'::uuid OR r.status IS DISTINCT FROM 'active'
      OR r.recipe_type IS DISTINCT FROM 'direct_sale' OR r.menu_item_id IS DISTINCT FROM entry.menu_item_id
      OR r.output_stock_item_id IS DISTINCT FROM entry.old_recipe_stock_id OR r.yield_quantity IS DISTINCT FROM 1::numeric THEN
      RAISE EXCEPTION 'Recipe % changed since inspection; entire batch rolled back',entry.recipe_id;
    END IF;
    SELECT * INTO s FROM public.stock_items WHERE id=entry.new_stock_id FOR UPDATE;
    IF s.id IS NULL OR s.organization_id IS DISTINCT FROM r.organization_id
      OR s.branch_id IS DISTINCT FROM r.branch_id OR s.name IS DISTINCT FROM entry.new_name
      OR s.base_unit IS DISTINCT FROM entry.new_unit THEN
      RAISE EXCEPTION 'Owned stock % identity/owner/unit changed; entire batch rolled back',entry.new_stock_id;
    END IF;
    SELECT * INTO m FROM public.menu_items WHERE id=entry.menu_item_id FOR UPDATE;
    IF m.id IS NULL OR m.organization_id IS DISTINCT FROM r.organization_id
      OR m.branch_id IS DISTINCT FROM r.branch_id OR m.consumption_mode IS DISTINCT FROM 'direct_stock' THEN
      RAISE EXCEPTION 'Menu % identity/owner/mode changed; entire batch rolled back',entry.menu_item_id;
    END IF;
    IF m.stock_item_id=s.id AND m.stock_quantity_per_sale=1 AND m.stock_unit=entry.new_unit AND m.name=entry.new_name THEN CONTINUE; END IF;
    IF m.stock_item_id IS DISTINCT FROM entry.old_menu_stock_id OR m.stock_quantity_per_sale IS DISTINCT FROM 1::numeric
      OR m.stock_unit IS DISTINCT FROM entry.old_unit THEN
      RAISE EXCEPTION 'Menu % mapping changed since inspection; entire batch rolled back',entry.menu_item_id;
    END IF;
    old_value:=jsonb_build_object('name',m.name,'stock_item_id',m.stock_item_id,'quantity',m.stock_quantity_per_sale,'unit',m.stock_unit);
    UPDATE public.menu_items SET name=entry.new_name,stock_item_id=s.id,stock_quantity_per_sale=1,stock_unit=entry.new_unit
      WHERE id=m.id AND organization_id=r.organization_id;
    SELECT jsonb_build_object('name',name,'stock_item_id',stock_item_id,'quantity',stock_quantity_per_sale,'unit',stock_unit)
      INTO new_value FROM public.menu_items WHERE id=m.id;
    IF new_value IS DISTINCT FROM jsonb_build_object('name',entry.new_name,'stock_item_id',s.id,'quantity',1,'unit',entry.new_unit) THEN
      RAISE EXCEPTION 'Menu % update not confirmed; entire batch rolled back',entry.menu_item_id;
    END IF;
    INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
    VALUES(r.organization_id,r.branch_id,auth.uid(),'Lovable SQL repair ('||current_user||')',
      'repair.mawimbi_owned_menu_stock','kitchen',m.id::text,old_value,new_value,
      'Correct existing hotel menu to reviewed existing hotel-owned stock and its container unit. Variant selection authorized 18 Nov. No stock moved; approved recipe history retained for reviewed version correction.');
  END LOOP;
  IF EXISTS(SELECT 1 FROM neo_mawimbi_recipe_before before_row
    LEFT JOIN public.recipes recipe ON recipe.id=before_row.id
    WHERE to_jsonb(recipe) IS DISTINCT FROM before_row.snapshot) THEN
    RAISE EXCEPTION 'Approved recipe history changed during menu repair; entire batch rolled back';
  END IF;
END $repair$;
COMMIT;
SELECT jsonb_build_object('hotel_menus_bound_to_owned_stock',count(*),
  'audit_records',(SELECT count(*) FROM public.audit_logs WHERE organization_id='c10e5d20-dc04-4959-9db4-4c2afb9d2f8c' AND action='repair.mawimbi_owned_menu_stock'),
  'historical_recipes_unchanged',true) AS mapping_repair_result
FROM public.menu_items m JOIN public.stock_items s ON s.id=m.stock_item_id
WHERE m.id IN ('196b4b7b-bc3e-4c28-a01b-0da8c8ec7014','1989c450-5c8b-4f42-a6b4-d03c9676a5a4','28ce038d-f75c-413e-a4f3-ae4f950a2b25','2998e7da-e669-4c7e-bf85-29e904d65af6','637f9d93-1c01-407f-8e46-0e78f7d78d72','7b3a585d-a61d-44ed-b436-e8713ecdc7f9','7b806f6d-5eb1-4729-8327-d36d243cdfa1','88a963a5-a8a1-4141-9ae9-060e2cbc00b2','8ffc9ee2-6528-4c0c-8205-dff57c4b3bd8','9428c851-d43e-4b32-b482-8b9d0a8ef6c0','94935aec-39c8-4f4c-a1c2-87e0fb260088','a7ef8428-5b65-41ad-9508-05c7fb4dc4f1','a90e2b26-4969-4087-a292-38de83eb0062','af98b5d1-e230-41fb-9320-7774b9a7b284','d000305a-0f44-4b71-98ba-e1a91827486a','d17f9ce1-b9f6-48fa-a241-82020c928776','d87f1c61-1769-4f0c-97a0-e77aa049e8e7','dafdf54b-eb87-4cd7-a5d0-5f1b9e5baafb','db209b05-d157-40fc-b55e-b3ba57973f33','ea10ec95-1b74-41ff-b466-56836bef440a','fb2ed640-1d4b-40f7-a601-7c29101ffd98')
  AND m.organization_id='c10e5d20-dc04-4959-9db4-4c2afb9d2f8c' AND m.branch_id='c6169bc5-2123-4f2e-a660-c2aa81b83df2'
  AND s.organization_id=m.organization_id AND s.branch_id=m.branch_id
  AND m.consumption_mode='direct_stock' AND m.stock_quantity_per_sale=1 AND m.stock_unit=s.base_unit;
