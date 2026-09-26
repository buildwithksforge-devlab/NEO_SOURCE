
CREATE OR REPLACE FUNCTION public.neo_canonical_channel(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _raw IS NULL OR btrim(_raw) = '' THEN 'other'
    ELSE (
      SELECT CASE k
        WHEN 'neo_app' THEN 'neo_app'
        WHEN 'customer_app' THEN 'neo_app'
        WHEN 'customerapp' THEN 'neo_app'
        WHEN 'guest_app' THEN 'neo_app'
        WHEN 'mobile_app' THEN 'neo_app'
        WHEN 'app' THEN 'neo_app'
        WHEN 'hotel_website' THEN 'hotel_website'
        WHEN 'customer_web' THEN 'hotel_website'
        WHEN 'web' THEN 'hotel_website'
        WHEN 'online' THEN 'hotel_website'
        WHEN 'website' THEN 'hotel_website'
        WHEN 'qr' THEN 'qr'
        WHEN 'qr_code' THEN 'qr'
        WHEN 'table_qr' THEN 'qr'
        WHEN 'room_qr' THEN 'room_qr'
        WHEN 'staff_pos' THEN 'staff_pos'
        WHEN 'staff_taken' THEN 'staff_pos'
        WHEN 'staff_assisted' THEN 'staff_pos'
        WHEN 'waiter' THEN 'staff_pos'
        WHEN 'waiter_pos' THEN 'staff_pos'
        WHEN 'bar_pos' THEN 'staff_pos'
        WHEN 'pos' THEN 'staff_pos'
        WHEN 'counter' THEN 'staff_pos'
        WHEN 'phone' THEN 'phone'
        WHEN 'staff_phone' THEN 'phone'
        WHEN 'call_centre' THEN 'phone'
        WHEN 'call_center' THEN 'phone'
        WHEN 'telephone' THEN 'phone'
        WHEN 'walk_in' THEN 'walk_in'
        WHEN 'walkin' THEN 'walk_in'
        WHEN 'counter_walk_in' THEN 'walk_in'
        WHEN 'room_service' THEN 'room_service'
        WHEN 'in_room' THEN 'room_service'
        WHEN 'partner' THEN 'partner'
        WHEN 'corporate_portal' THEN 'partner'
        WHEN 'supplier_portal' THEN 'partner'
        WHEN 'rider' THEN 'rider'
        WHEN 'rider_app' THEN 'rider'
        WHEN 'external_integration' THEN 'external_integration'
        WHEN 'imported' THEN 'external_integration'
        WHEN 'import' THEN 'external_integration'
        WHEN 'migration' THEN 'external_integration'
        WHEN 'api' THEN 'external_integration'
        WHEN 'integration' THEN 'external_integration'
        WHEN 'ota' THEN 'external_integration'
        WHEN 'uat' THEN 'other'
        ELSE 'other'
      END
      FROM (SELECT replace(replace(lower(btrim(_raw)), '-', '_'), ' ', '_') AS k) s
    )
  END;
$$;

COMMENT ON FUNCTION public.neo_canonical_channel(text) IS
  'Normalises any recorded order source to one canonical channel: neo_app, hotel_website, qr, room_qr, staff_pos, phone, walk_in, room_service, partner, rider, external_integration, other. Channel records where an order came from; it never decides who the caller is or what they may do.';
