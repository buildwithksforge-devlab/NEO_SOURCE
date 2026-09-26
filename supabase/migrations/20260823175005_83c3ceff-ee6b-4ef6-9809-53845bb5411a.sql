CREATE UNIQUE INDEX IF NOT EXISTS event_bookings_org_reference_uidx
  ON public.event_bookings (organization_id, event_reference);