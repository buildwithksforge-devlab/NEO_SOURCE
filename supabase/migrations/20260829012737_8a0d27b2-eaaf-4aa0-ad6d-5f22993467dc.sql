ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS reorder_point numeric,
  ADD COLUMN IF NOT EXISTS par_level numeric;

COMMENT ON COLUMN public.stock_items.reorder_point IS 'Level at or below which the item should be reordered. Falls back to min_level when null.';
COMMENT ON COLUMN public.stock_items.par_level IS 'Target level to replenish back up to. Falls back to max_level when null.';

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS whatsapp text,
  ADD COLUMN IF NOT EXISTS preferred boolean NOT NULL DEFAULT false;

ALTER TABLE public.rfq_suppliers
  ADD COLUMN IF NOT EXISTS dispatch_state text NOT NULL DEFAULT 'prepared',
  ADD COLUMN IF NOT EXISTS dispatch_channel text,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS dispatched_by uuid,
  ADD COLUMN IF NOT EXISTS dispatch_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rfq_suppliers_dispatch_state_check'
  ) THEN
    ALTER TABLE public.rfq_suppliers
      ADD CONSTRAINT rfq_suppliers_dispatch_state_check
      CHECK (dispatch_state IN ('prepared','ready-to-send','downloaded','marked-sent','sent'));
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.inventory_reorder_suggestions();

CREATE FUNCTION public.inventory_reorder_suggestions()
RETURNS TABLE(
  id uuid,
  name text,
  base_unit text,
  on_hand numeric,
  min_level numeric,
  suggested_quantity numeric,
  average_cost numeric,
  preferred_supplier_id uuid,
  supplier_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.name, i.base_unit,
         COALESCE(SUM(l.quantity_on_hand), 0) AS on_hand,
         i.min_level,
         GREATEST(
           COALESCE(
             NULLIF(i.par_level, 0),
             NULLIF(i.max_level, 0),
             NULLIF(i.reorder_quantity, 0),
             i.min_level * 2
           ) - COALESCE(SUM(l.quantity_on_hand), 0),
           0
         ) AS suggested_quantity,
         i.average_cost, i.preferred_supplier_id, s.name
    FROM stock_items i
    LEFT JOIN stock_levels l ON l.stock_item_id = i.id
    LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
   WHERE i.organization_id = current_org_id()
     AND i.active
     AND COALESCE(NULLIF(i.reorder_point, 0), i.min_level) > 0
   GROUP BY i.id, s.name
  HAVING COALESCE(SUM(l.quantity_on_hand), 0) <= COALESCE(NULLIF(i.reorder_point, 0), i.min_level)
   ORDER BY (COALESCE(SUM(l.quantity_on_hand), 0) / NULLIF(COALESCE(NULLIF(i.reorder_point, 0), i.min_level), 0));
$$;

REVOKE ALL ON FUNCTION public.inventory_reorder_suggestions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_reorder_suggestions() TO authenticated;