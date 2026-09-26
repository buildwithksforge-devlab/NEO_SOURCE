ALTER TABLE public.asset_categories ADD COLUMN IF NOT EXISTS description text;

CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_org_name_unique
  ON public.asset_categories (organization_id, lower(btrim(name)));