ALTER TABLE public.public_workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  ADD COLUMN IF NOT EXISTS published_by_name text,
  ADD COLUMN IF NOT EXISTS unpublished_at timestamptz,
  ADD COLUMN IF NOT EXISTS draft_saved_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'public_workspaces_status_check'
  ) THEN
    ALTER TABLE public.public_workspaces
      ADD CONSTRAINT public_workspaces_status_check
      CHECK (status IN ('draft','published','unpublished'));
  END IF;
END $$;

UPDATE public.public_workspaces SET status = 'published' WHERE published AND status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS public_workspaces_org_app_key_uidx
  ON public.public_workspaces (organization_id, app_key);