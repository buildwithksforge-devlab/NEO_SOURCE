DROP POLICY IF EXISTS "Creators read their own provisioning attempts" ON public.workspace_provisioning_attempts;
CREATE POLICY "Creators read their own provisioning attempts"
  ON public.workspace_provisioning_attempts FOR SELECT TO authenticated
  USING (user_id = auth.uid());