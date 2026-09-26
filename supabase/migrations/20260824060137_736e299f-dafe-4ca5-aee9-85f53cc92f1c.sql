DO $$
DECLARE
  actor uuid := 'f6e1e07f-3664-4608-bbd7-a3ef2e0c4bfc';
  org uuid; rid uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  SELECT organization_id INTO org FROM public.profiles WHERE id = actor;

  FOR rid IN
    SELECT r.id
      FROM public.finance_posting_receipts r
      JOIN public.guest_laundry_orders lo ON lo.id = r.source_id
     WHERE r.organization_id = org
       AND r.source_module = 'laundry_order'
       AND r.status IN ('failed','blocked')
       AND lo.folio_id IS NOT NULL
       AND coalesce(lo.posting_status,'') = 'posted'
  LOOP
    PERFORM public.neo_posting_receipt_action(rid, 'resolve',
      'Charge is on the guest folio and recognised there; this duplicate order-level posting record is closed.');
  END LOOP;
END $$;