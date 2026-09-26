-- Device subscriptions belong to a single authenticated worker and workspace.
-- Push payloads deliberately contain no guest/financial details on a lock screen.
CREATE TABLE IF NOT EXISTS public.worker_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS worker_push_subscriptions_user_idx
  ON public.worker_push_subscriptions (organization_id, user_id);

ALTER TABLE public.worker_push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_push_subscriptions TO authenticated;
GRANT ALL ON public.worker_push_subscriptions TO service_role;

CREATE POLICY worker_push_read ON public.worker_push_subscriptions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()));
CREATE POLICY worker_push_insert ON public.worker_push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()));
CREATE POLICY worker_push_update ON public.worker_push_subscriptions FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()));
CREATE POLICY worker_push_delete ON public.worker_push_subscriptions FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()));

CREATE TABLE IF NOT EXISTS public.worker_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  accepted_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, notification_id),
  FOREIGN KEY (subscription_id, organization_id, user_id)
    REFERENCES public.worker_push_subscriptions(id, organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS worker_push_deliveries_due_idx
  ON public.worker_push_deliveries (next_attempt_at) WHERE status IN ('queued','sending');
ALTER TABLE public.worker_push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_push_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.worker_push_deliveries TO authenticated;
GRANT ALL ON public.worker_push_deliveries TO service_role;
CREATE POLICY worker_push_delivery_read ON public.worker_push_deliveries FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND organization_id = (SELECT public.current_org_id()));

CREATE OR REPLACE FUNCTION public.neo_enqueue_personal_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Scope notifications without a named user require a separate audited
  -- recipient fan-out. Never send a department notice to an arbitrary device.
  IF NEW.user_id IS NOT NULL THEN
    INSERT INTO public.worker_push_deliveries (organization_id, user_id, subscription_id, notification_id)
    SELECT NEW.organization_id, NEW.user_id, s.id, NEW.id
    FROM public.worker_push_subscriptions s
    JOIN public.notification_preferences p
      ON p.organization_id = s.organization_id AND p.user_id = s.user_id
    WHERE s.organization_id = NEW.organization_id AND s.user_id = NEW.user_id AND p.push
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.neo_enqueue_personal_push() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS neo_enqueue_personal_push ON public.notifications;
CREATE TRIGGER neo_enqueue_personal_push AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.neo_enqueue_personal_push();

CREATE OR REPLACE FUNCTION public.neo_claim_worker_push(_limit integer DEFAULT 25)
RETURNS TABLE(id uuid, endpoint text, p256dh text, auth_key text, notification_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Only the server may dispatch push' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT d.id FROM public.worker_push_deliveries d
      WHERE (d.status = 'queued' AND d.next_attempt_at <= now())
         OR (d.status = 'sending' AND d.locked_until < now())
      ORDER BY d.next_attempt_at, d.id
      LIMIT LEAST(GREATEST(_limit, 1), 50)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE public.worker_push_deliveries d
      SET status = 'sending', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
      FROM due WHERE d.id = due.id
      RETURNING d.id, d.subscription_id, d.notification_id
    )
    SELECT c.id, s.endpoint, s.p256dh, s.auth_key, c.notification_id
    FROM claimed c JOIN public.worker_push_subscriptions s ON s.id = c.subscription_id;
END $$;
REVOKE ALL ON FUNCTION public.neo_claim_worker_push(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_claim_worker_push(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_worker_push_test() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _uid uuid := auth.uid(); _id uuid;
BEGIN
  IF _org IS NULL OR _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in as a worker to test phone alerts' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.worker_push_subscriptions
                 WHERE organization_id = _org AND user_id = _uid) THEN
    RAISE EXCEPTION 'Register a device before sending a test alert';
  END IF;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE organization_id = _org
             AND user_id = _uid AND event_type = 'worker.push.test'
             AND created_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'Wait one minute before sending another test alert';
  END IF;
  INSERT INTO public.notifications
    (organization_id, user_id, category, title, body, priority, link, event_type)
  VALUES (_org, _uid, 'system-alert', 'Phone alert test',
          'Open NEØ to confirm alerts are reaching this device.', 'normal',
          '/notifications', 'worker.push.test') RETURNING id INTO _id;
  RETURN _id;
END $$;
REVOKE ALL ON FUNCTION public.neo_worker_push_test() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_worker_push_test() TO authenticated, service_role;
