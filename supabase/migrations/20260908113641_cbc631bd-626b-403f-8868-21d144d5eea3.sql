CREATE OR REPLACE FUNCTION public.neo_guest_room_offers(
  _org uuid, _branch uuid, _arrival date, _departure date,
  _adults integer DEFAULT 1, _children integer DEFAULT 0)
RETURNS TABLE(
  room_type_id uuid, room_type_name text, description text, max_occupancy integer,
  amenities jsonb, rooms_available integer, rate_plan_id uuid, rate_plan_name text,
  nightly_rate numeric, currency text, tax_rate numeric, service_charge_rate numeric,
  nights integer, total_amount numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _nights integer;
BEGIN
  IF _org IS NULL OR _branch IS NULL THEN RETURN; END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org) THEN RETURN; END IF;
  _nights := (_departure - _arrival);

  RETURN QUERY
  WITH bounds AS (SELECT _arrival AS a, _departure AS d),
  types AS (
    SELECT rt.id, rt.name, rt.description, rt.max_occupancy, COALESCE(rt.amenities, '[]'::jsonb) AS amenities
      FROM public.room_types rt
     WHERE rt.organization_id = _org
       AND rt.branch_id = _branch
       AND COALESCE(rt.status,'active') = 'active'
       AND COALESCE(rt.max_occupancy, 99) >= (COALESCE(_adults,1) + COALESCE(_children,0))
  ),
  -- Same rules as the front office availability engine, scoped to this
  -- property directly so a guest account (which has no staff workspace) sees
  -- the identical inventory.
  candidates AS (
    SELECT r.id, r.room_type_id AS rt_id,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
      FROM public.rooms r
      JOIN types t ON t.id = r.room_type_id
      CROSS JOIN bounds
     WHERE r.organization_id = _org
       AND r.branch_id = _branch
       AND r.status = 'active'
       AND r.maintenance_status = 'operational'
       AND (bounds.a > current_date
            OR (public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
                AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
                AND coalesce(r.occupancy_status,'vacant') = 'vacant'))
       AND NOT (r.out_of_order_from IS NOT NULL
                AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                    && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.reservations res
          WHERE res.room_id = r.id
            AND res.status IN ('confirmed','guaranteed','checked-in','in-house')
            AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.room_assignments a
          WHERE a.room_id = r.id AND a.status = 'active'
            AND daterange(a.start_date, a.end_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.room_blocks bl
          WHERE bl.room_id = r.id AND bl.status = 'active'
            AND daterange(bl.start_date, bl.end_date, '[]') && daterange(bounds.a, bounds.d, '[)'))
       AND NOT EXISTS (
         SELECT 1 FROM public.reservation_holds h
          WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
            AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
  ),
  held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
      FROM public.group_room_blocks gb
      JOIN public.group_bookings g ON g.id = gb.group_booking_id
      CROSS JOIN bounds
     WHERE gb.status = 'active' AND g.organization_id = _org AND g.branch_id = _branch
       AND g.status NOT IN ('cancelled','closed')
       AND daterange(gb.start_date, gb.end_date, '[]') && daterange(bounds.a, bounds.d, '[)')
     GROUP BY gb.room_type_id
  ),
  demand AS (
    SELECT res.room_type_id AS rt_id, count(*)::int AS qty
      FROM public.reservations res
      CROSS JOIN bounds
     WHERE res.organization_id = _org AND res.branch_id = _branch
       AND res.room_id IS NULL AND res.room_type_id IS NOT NULL
       AND res.status IN ('confirmed','guaranteed')
       AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)')
     GROUP BY res.room_type_id
  ),
  avail AS (
    SELECT t.id,
           (SELECT count(*) FROM candidates c
             LEFT JOIN held h ON h.rt_id = c.rt_id
             LEFT JOIN demand dm ON dm.rt_id = c.rt_id
            WHERE c.rt_id = t.id AND c.rn > COALESCE(h.qty,0) + COALESCE(dm.qty,0))::integer AS free
      FROM types t
  ),
  plan AS (
    SELECT DISTINCT ON (rp.room_type_id)
           rp.room_type_id, rp.id, rp.name, rp.base_rate, rp.currency,
           COALESCE(rp.tax_rate,0) AS tax_rate, COALESCE(rp.service_charge_rate,0) AS service_charge_rate
      FROM public.rate_plans rp
     WHERE rp.organization_id = _org
       AND rp.branch_id = _branch
       AND COALESCE(rp.status,'active') = 'active'
       AND (rp.valid_from IS NULL OR rp.valid_from <= _arrival)
       AND (rp.valid_to IS NULL OR rp.valid_to >= _departure)
       AND rp.room_type_id IS NOT NULL
     ORDER BY rp.room_type_id, rp.base_rate ASC NULLS LAST
  )
  SELECT t.id, t.name, t.description, t.max_occupancy, t.amenities,
         a.free,
         p.id, p.name,
         COALESCE(p.base_rate,0),
         COALESCE(p.currency,'KES'),
         COALESCE(p.tax_rate,0),
         COALESCE(p.service_charge_rate,0),
         _nights,
         ROUND(COALESCE(p.base_rate,0) * _nights
               * (1 + COALESCE(p.tax_rate,0)/100 + COALESCE(p.service_charge_rate,0)/100), 2)
    FROM types t
    JOIN avail a ON a.id = t.id
    LEFT JOIN plan p ON p.room_type_id = t.id
   WHERE a.free > 0
   ORDER BY COALESCE(p.base_rate, 0) ASC, t.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_guest_room_offers(uuid, uuid, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_room_offers(uuid, uuid, date, date, integer, integer) TO authenticated, service_role;