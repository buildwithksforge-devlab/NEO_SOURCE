ALTER TABLE public.data_migration_batches
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS processed_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS transformations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS resolutions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS profile_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS target_module text,
  ADD COLUMN IF NOT EXISTS entry_point text,
  ADD COLUMN IF NOT EXISTS failed_rows integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid;

ALTER TABLE public.data_migration_rows
  ADD COLUMN IF NOT EXISTS severity text,
  ADD COLUMN IF NOT EXISTS row_key text,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text;

CREATE UNIQUE INDEX IF NOT EXISTS data_migration_rows_batch_row_uk
  ON public.data_migration_rows (batch_id, row_number);

CREATE INDEX IF NOT EXISTS data_migration_rows_imported_record_idx
  ON public.data_migration_rows (imported_record_id)
  WHERE imported_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS data_migration_batches_stage_idx
  ON public.data_migration_batches (organization_id, stage);