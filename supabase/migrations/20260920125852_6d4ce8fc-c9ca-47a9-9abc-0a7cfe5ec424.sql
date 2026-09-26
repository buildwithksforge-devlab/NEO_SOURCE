CREATE UNIQUE INDEX IF NOT EXISTS stock_categories_org_normalized_name_unique
  ON public.stock_categories (organization_id, lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS stock_item_groups_org_normalized_name_unique
  ON public.stock_item_groups (organization_id, lower(btrim(name)));