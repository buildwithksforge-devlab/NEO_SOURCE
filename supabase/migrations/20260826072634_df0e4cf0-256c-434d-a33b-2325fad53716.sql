-- Rooms holding a guest who is already checked in cannot be sitting in a
-- housekeeping "not ready" state; align them with the stay they are hosting.
UPDATE public.rooms rm
SET status = 'occupied',
    room_condition = 'occupied',
    housekeeping_status = 'occupied',
    updated_at = now()
FROM public.reservations r
WHERE r.room_id = rm.id
  AND lower(r.status) = 'checked-in'
  AND (lower(COALESCE(rm.room_condition, '')) IN ('dirty','vacant-dirty','cleaning','inspection','not-ready','in-progress')
    OR lower(COALESCE(rm.housekeeping_status, '')) IN ('dirty','cleaning','inspection','not-ready','in-progress'));

-- Several checked-in reservations carry a guest folio but no stay record, so
-- the accommodation accrual chain could never run against them. Rebuild the
-- missing stay records from the reservation itself and link the folio.
INSERT INTO public.stays (organization_id, branch_id, reservation_id, customer_id, room_id, checked_in_at, expected_departure, status)
SELECT r.organization_id, r.branch_id, r.id, r.customer_id, r.room_id,
       (r.arrival_date + time '14:00') AT TIME ZONE 'UTC', r.departure_date, 'in-house'
FROM public.reservations r
WHERE lower(r.status) = 'checked-in'
  AND NOT EXISTS (SELECT 1 FROM public.stays s WHERE s.reservation_id = r.id);

UPDATE public.folios f
SET stay_id = s.id, updated_at = now()
FROM public.stays s
WHERE s.reservation_id = f.reservation_id
  AND f.stay_id IS NULL
  AND f.folio_type = 'guest';

-- Accrue every elapsed night that has no accommodation line yet. Amounts come
-- from the reservation's own agreed nightly rate — nothing is invented.
WITH nights AS (
  SELECT f.id AS folio_id, f.branch_id, r.id AS reservation_id, r.organization_id,
         r.nightly_rate, COALESCE(rp.tax_rate, 0) AS tax_rate, rm.room_number, d::date AS night
  FROM public.stays s
  JOIN public.reservations r ON r.id = s.reservation_id
  JOIN public.folios f ON f.stay_id = s.id AND f.folio_type = 'guest' AND f.status = 'open'
  LEFT JOIN public.rate_plans rp ON rp.id = r.rate_plan_id
  LEFT JOIN public.rooms rm ON rm.id = s.room_id
  CROSS JOIN LATERAL generate_series(r.arrival_date, LEAST(current_date, r.departure_date - 1), interval '1 day') d
  WHERE s.status = 'in-house' AND COALESCE(r.nightly_rate, 0) > 0
)
INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type, category,
  source_module, description, operational_date, quantity, unit_price, gross_amount, tax_amount, net_amount)
SELECT n.organization_id, n.branch_id, n.folio_id, n.reservation_id, 'charge', 'accommodation', 'pms',
       'Accommodation — room ' || COALESCE(n.room_number, '') || ' · ' || n.night::text,
       n.night, 1, n.nightly_rate, n.nightly_rate,
       round(n.nightly_rate * n.tax_rate / 100, 2),
       n.nightly_rate + round(n.nightly_rate * n.tax_rate / 100, 2)
FROM nights n
WHERE NOT EXISTS (
  SELECT 1 FROM public.folio_lines fl
  WHERE fl.folio_id = n.folio_id AND fl.category = 'accommodation'
    AND fl.operational_date = n.night AND fl.line_type = 'charge'
);

-- Realign stored folio totals with the posted charge lines.
UPDATE public.folios f
SET total_charges = agg.posted,
    balance = round(agg.posted - COALESCE(f.total_payments, 0), 2),
    updated_at = now()
FROM (
  SELECT fo.id,
         round(COALESCE(SUM(CASE WHEN fl.line_type = 'charge' AND fl.status = 'posted'
                                 THEN fl.gross_amount ELSE 0 END), 0), 2) AS posted
  FROM public.folios fo
  LEFT JOIN public.folio_lines fl ON fl.folio_id = fo.id
  GROUP BY fo.id
) agg
WHERE agg.id = f.id
  AND round(COALESCE(f.total_charges, 0), 2) <> agg.posted;