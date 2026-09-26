-- Group 4 / Stage 13-14: menu publish lifecycle + structured import batches

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS publish_status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid;

DO $$ BEGIN
  ALTER TABLE public.menu_items
    ADD CONSTRAINT menu_items_publish_status_chk
    CHECK (publish_status IN ('draft', 'published', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS menu_items_publish_idx
  ON public.menu_items (organization_id, publish_status);

CREATE TABLE IF NOT EXISTS public.menu_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  reference text,
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  rejected_rows integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'review',
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.menu_import_batches TO authenticated;
GRANT ALL ON public.menu_import_batches TO service_role;
ALTER TABLE public.menu_import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "menu import read" ON public.menu_import_batches;
CREATE POLICY "menu import read" ON public.menu_import_batches
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "menu import write" ON public.menu_import_batches;
CREATE POLICY "menu import write" ON public.menu_import_batches
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('restaurant', 'create'));
DROP POLICY IF EXISTS "menu import update" ON public.menu_import_batches;
CREATE POLICY "menu import update" ON public.menu_import_batches
  FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('restaurant', 'edit'))
  WITH CHECK (organization_id = public.current_org_id());

-- Publishing is an explicit, permission-checked, audited action.
CREATE OR REPLACE FUNCTION public.publish_menu_items(_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _n int := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organization for the current user'; END IF;
  IF NOT public.has_permission('restaurant', 'menu', 'edit') THEN
    RAISE EXCEPTION 'Not authorised to publish menu items';
  END IF;

  UPDATE public.menu_items
     SET publish_status = 'published', published_at = now(), published_by = auth.uid(), updated_at = now()
   WHERE organization_id = _org AND id = ANY (_ids) AND publish_status = 'draft';
  GET DIAGNOSTICS _n = ROW_COUNT;

  IF _n > 0 THEN
    INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, new_value)
    VALUES (_org, auth.uid(),
            coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
            'menu.items.published', 'restaurant', jsonb_build_object('count', _n));
  END IF;
  RETURN _n;
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_menu_items(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_menu_items(uuid[]) TO authenticated, service_role;