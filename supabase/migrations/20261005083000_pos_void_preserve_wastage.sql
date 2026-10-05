-- POS void inventory truth:
-- - genuine sale consumption may be restored when an unprepared item is voided;
-- - wastage is physical loss and must never be returned to available stock;
-- - prepared-item voids remain waste through neo_pos_item_void_effect's existing
--   prepared branch.
--
-- Keep the existing trigger/function architecture and change only the movement
-- set eligible for reversal.

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
       'movement_type IN (''consumption'',''wastage'')'
       IN v_def
     ) = 0 THEN
    RAISE EXCEPTION
      'Expected POS void reversal clause was not found; migration refused rather than changing an unknown function version';
  END IF;

  v_def := replace(
    v_def,
    'movement_type IN (''consumption'',''wastage'')',
    'movement_type = ''consumption'''
  );

  v_def := replace(
    v_def,
    'CASE WHEN v_mv.movement_type = ''wastage'' THEN ''Void reversal · wastage allowance returned to '' ELSE ''Void reversal · order line returned to '' END',
    '''Void reversal · unprepared order line returned to '''
  );

  v_def := replace(
    v_def,
    'CASE WHEN v_mv.movement_type = ''wastage'' THEN ''reverse-waste:'' ELSE ''reverse:'' END',
    '''reverse:'''
  );

  EXECUTE v_def;
END
$$;

COMMENT ON FUNCTION public.neo_pos_item_void_effect() IS
'Handles POS item void inventory effects. Prepared recipe items become waste. Unprepared consumption may be reversed. Wastage movements are never restored to stock.';