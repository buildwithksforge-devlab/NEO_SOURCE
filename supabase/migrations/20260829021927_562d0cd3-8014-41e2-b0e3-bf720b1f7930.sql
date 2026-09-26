-- Own access snapshot only; no cross-user or cross-tenant read.
CREATE POLICY user_access_snapshots_select_self
  ON public.user_access_snapshots FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND organization_id = public.current_org_id());

GRANT SELECT ON public.user_access_snapshots TO authenticated;
GRANT ALL ON public.user_access_snapshots TO service_role;

-- Credential stores stay deny-all for every client role by design: they hold
-- provider secrets and are only ever read by trusted server processes.
REVOKE ALL ON public.mpesa_settings FROM anon, authenticated;
REVOKE ALL ON public.etims_settings FROM anon, authenticated;
REVOKE ALL ON public.ai_provider_settings FROM anon, authenticated;
GRANT ALL ON public.mpesa_settings TO service_role;
GRANT ALL ON public.etims_settings TO service_role;
GRANT ALL ON public.ai_provider_settings TO service_role;

COMMENT ON TABLE public.mpesa_settings IS 'Secrets store: RLS on, intentionally no client policy. Server-side access only.';
COMMENT ON TABLE public.etims_settings IS 'Secrets store: RLS on, intentionally no client policy. Server-side access only.';
COMMENT ON TABLE public.ai_provider_settings IS 'Secrets store: RLS on, intentionally no client policy. Server-side access only.';