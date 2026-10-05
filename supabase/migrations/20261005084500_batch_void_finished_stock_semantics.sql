-- Batch POS void truth.
--
-- A batch item is finished/prepared stock created by kitchen production.
-- Production already consumes the raw ingredients and receives the finished
-- output stock into inventory.
--
-- Therefore:
--   direct_stock = packaged stock; POS void may return it.
--   batch before preparation/service = finished stock may be returned.
--   batch after preparation/service = physical waste; do not restore it.
--   recipe after preparation/service = physical waste; do not restore it.
--
-- POS void must never reverse the raw production ingredients.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'neo_pos_item_void_effect'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'neo_pos_item_void_effect() was not found';
  END IF;

  IF position(
       'v_direct := COALESCE(v_mode,'''') IN (''direct_stock'',''batch'');'
       IN v_def
     ) = 0 THEN
    RAISE EXCEPTION
      'Expected direct/batch void classification was not found; migration refused rather than changing an unknown function version';
  END IF;

  v_def := replace(
    v_def,
    'v_direct := COALESCE(v_mode,'''') IN (''direct_stock'',''batch'');',
    'v_direct := COALESCE(v_mode,'''') = ''direct_stock'';'
  );

  EXECUTE v_def;
END
$$;

COMMENT ON FUNCTION public.neo_pos_item_void_effect() IS
'POS void inventory effects: direct packaged stock may be returned; unprepared finished batch stock may be returned; prepared recipe or batch items remain consumed and are recorded as waste; existing wastage movements are never restored.';