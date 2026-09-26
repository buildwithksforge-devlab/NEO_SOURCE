ALTER TABLE public.payroll_posting_settings
  ADD COLUMN IF NOT EXISTS auto_post_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_post_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_post_updated_by uuid;

COMMENT ON COLUMN public.payroll_posting_settings.auto_post_enabled IS 'When true, an approved or locked payroll period with no blockers is posted to the finance books automatically through the same guarded routine used for manual posting.';