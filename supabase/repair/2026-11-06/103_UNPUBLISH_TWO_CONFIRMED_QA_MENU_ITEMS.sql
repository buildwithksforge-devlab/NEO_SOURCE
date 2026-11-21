-- Prepared from read-only anonymous storefront evidence on 8 November 2026.
-- Configuration-only: retain products, prices, recipe links and every transaction.
BEGIN;
DO $repair$
DECLARE r record; locked_rows integer;
BEGIN
  PERFORM id FROM public.menu_items
   WHERE organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
     AND branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
     AND id IN ('e8ad3125-9201-4415-b419-c38601e3e6ee'::uuid,'5244d491-670e-4323-8eb1-3c9cc8f72e35'::uuid)
   FOR UPDATE;
  GET DIAGNOSTICS locked_rows=ROW_COUNT;
  IF locked_rows<>2 THEN RAISE EXCEPTION 'Expected two inspected Savannah Nairobi QA products; inspect current records first'; END IF;
  FOR r IN
    SELECT mi.id,mi.name,mi.publish_status,mi.availability,
      CASE mi.id WHEN 'e8ad3125-9201-4415-b419-c38601e3e6ee'::uuid THEN 'NEO QA Egg Plate Sep27'
        ELSE 'NEO-UAT-20261022 Beef & Vegetable Plate TEST' END AS expected_name
    FROM public.menu_items mi
    WHERE mi.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
      AND mi.branch_id='2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid
      AND mi.id IN ('e8ad3125-9201-4415-b419-c38601e3e6ee'::uuid,'5244d491-670e-4323-8eb1-3c9cc8f72e35'::uuid)
  LOOP
    IF r.name IS DISTINCT FROM r.expected_name OR coalesce(r.publish_status,'published') NOT IN ('published','draft')
       OR r.availability IS NULL OR r.availability NOT IN ('available','temporarily-unavailable','sold-out','disabled') THEN
      RAISE EXCEPTION 'Inspected QA product identity/publication state changed: %',r.id;
    END IF;
    IF r.publish_status IS DISTINCT FROM 'draft' OR r.availability IS DISTINCT FROM 'disabled' THEN
      UPDATE public.menu_items SET publish_status='draft',availability='disabled' WHERE id=r.id;
      INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
      VALUES('aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid,'2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid,auth.uid(),'SQL repair',
        'menu.qa_unpublished','restaurant',r.id::text,
        jsonb_build_object('publish_status',r.publish_status,'availability',r.availability),
        jsonb_build_object('publish_status','draft','availability','disabled'),
        'NEO-BKL-M02: exact QA products confirmed visible through the anonymous published menu on 2026-11-08; retain all historical records.');
    END IF;
  END LOOP;
END $repair$;
COMMIT;
