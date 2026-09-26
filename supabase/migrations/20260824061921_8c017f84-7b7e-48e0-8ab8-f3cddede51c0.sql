CREATE OR REPLACE FUNCTION public.neo_source_org(_source_type text, _source_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE o uuid;
BEGIN
  CASE _source_type
    WHEN 'pos_order' THEN SELECT organization_id INTO o FROM pos_orders WHERE id=_source_id;
    WHEN 'folio_charge' THEN SELECT organization_id INTO o FROM folio_lines WHERE id=_source_id;
    WHEN 'folio_payment' THEN SELECT organization_id INTO o FROM payments WHERE id=_source_id;
    WHEN 'event_invoice' THEN SELECT organization_id INTO o FROM invoices WHERE id=_source_id;
    WHEN 'event_deposit' THEN SELECT organization_id INTO o FROM event_bookings WHERE id=_source_id;
    WHEN 'event_earned' THEN SELECT organization_id INTO o FROM event_bookings WHERE id=_source_id;
    WHEN 'event_cancellation' THEN SELECT organization_id INTO o FROM event_bookings WHERE id=_source_id;
    WHEN 'delivery_order' THEN SELECT organization_id INTO o FROM delivery_orders WHERE id=_source_id;
    WHEN 'laundry_order' THEN SELECT organization_id INTO o FROM guest_laundry_orders WHERE id=_source_id;
    WHEN 'supplier_invoice' THEN SELECT organization_id INTO o FROM supplier_invoices WHERE id=_source_id;
    WHEN 'supplier_payment' THEN SELECT organization_id INTO o FROM supplier_payments WHERE id=_source_id;
    ELSE o := NULL;
  END CASE;
  RETURN o;
END $$;

REVOKE ALL ON FUNCTION public.neo_source_org(text, uuid) FROM PUBLIC, anon, authenticated;