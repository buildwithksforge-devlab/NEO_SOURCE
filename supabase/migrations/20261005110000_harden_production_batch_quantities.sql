-- Production batch quantity truth:
-- actual_quantity = gross quantity produced before production waste.
-- net finished stock = actual_quantity - waste_quantity.
-- Refuse impossible/negative quantities before stock posting.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'neo_production_batch_post'
     AND pg_get_function_identity_arguments(p.oid) = '_batch uuid, _location uuid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'neo_production_batch_post(uuid, uuid) was not found';
  END IF;

  IF position(
       'IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN'
       IN v_def
     ) = 0 THEN
    RAISE EXCEPTION
      'Expected production quantity validation anchor was not found; migration refused';
  END IF;

  v_def := replace(
    v_def,
    'IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''no_actual_quantity'');
  END IF;',
    'IF COALESCE(v_b.actual_quantity, 0) <= 0 THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''no_actual_quantity'');
  END IF;

  IF COALESCE(v_b.waste_quantity, 0) < 0 THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''negative_waste'');
  END IF;

  IF COALESCE(v_b.waste_quantity, 0) > v_b.actual_quantity THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''waste_exceeds_production'');
  END IF;'
  );

  IF position('negative_waste' IN v_def) = 0
     OR position('waste_exceeds_production' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'Production quantity validation replacement did not apply; migration refused';
  END IF;

  EXECUTE v_def;
END
$$;

COMMENT ON FUNCTION public.neo_production_batch_post(uuid, uuid) IS
'Posts kitchen production to inventory. actual_quantity is gross production before production waste; waste_quantity must be non-negative and cannot exceed gross production.';