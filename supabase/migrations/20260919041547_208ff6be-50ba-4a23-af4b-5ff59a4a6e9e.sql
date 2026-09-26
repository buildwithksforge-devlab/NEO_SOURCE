UPDATE public.stock_items
   SET default_pour_ml = NULL
 WHERE default_pour_ml IS NOT NULL AND default_pour_ml <= 0;

UPDATE public.stock_items
   SET container_volume_ml = NULL
 WHERE container_volume_ml IS NOT NULL AND container_volume_ml <= 0;

ALTER TABLE public.stock_items
  ADD CONSTRAINT stock_items_default_pour_positive
  CHECK (default_pour_ml IS NULL OR default_pour_ml > 0);

ALTER TABLE public.stock_items
  ADD CONSTRAINT stock_items_volume_required_for_pours
  CHECK (
    (COALESCE(may_open_for_pours, false) = false AND COALESCE(tracking_method, 'whole') = 'whole')
    OR (container_volume_ml IS NOT NULL AND container_volume_ml > 0)
  );