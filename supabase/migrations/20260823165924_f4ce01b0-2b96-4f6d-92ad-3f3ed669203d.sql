CREATE UNIQUE INDEX IF NOT EXISTS rider_notification_events_idempotency_unique
  ON public.rider_notification_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;