-- PMS: prevent checking in a reservation before its arrival date.
-- Does not restrict creating future reservations or searching availability.
-- Deliberately verifies the installed function before replacing it.

BEGIN;

DO $pms_guard$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_anchor text :=
    'IF _res.id IS NULL THEN RAISE EXCEPTION ''Reservation not found''; END IF;';
  v_guard text := $insert$
  -- Actual occupancy must not begin before the reserved arrival date.
  -- Property-local operational date for the current Kenya deployment.
  IF _res.arrival_date >
     (now() AT TIME ZONE 'Africa/Nairobi')::date
  THEN
    RAISE EXCEPTION
      'Check-in is not permitted before the reservation arrival date (%)',
      _res.arrival_date
      USING ERRCODE = '22023';
  END IF;
$insert$;
BEGIN
  v_function := to_regprocedure(
    'public.pms_check_in(uuid,integer,text)'
  );

  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Expected pms_check_in function is missing';
  END IF;

  SELECT pg_get_functiondef(v_function)
    INTO v_definition;

  IF v_definition IS NULL
     OR length(v_definition) - length(replace(v_definition,v_anchor,''))
        <> length(v_anchor)
  THEN
    RAISE EXCEPTION
      'Installed check-in function differs; manual review required';
  END IF;

  IF position(
    'Check-in is not permitted before the reservation arrival date'
    IN v_definition
  ) > 0 THEN
    RAISE EXCEPTION 'Check-in guard is already present';
  END IF;

  v_definition := replace(
    v_definition,
    v_anchor,
    v_anchor || E'\n' || v_guard
  );

  EXECUTE v_definition;
END;
$pms_guard$;

DO $pms_verify$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.pms_check_in(uuid,integer,text)'::regprocedure
  ) INTO v_definition;

  IF position(
    'Check-in is not permitted before the reservation arrival date'
    IN v_definition
  ) = 0 THEN
    RAISE EXCEPTION 'Check-in date guard installation failed';
  END IF;
END;
$pms_verify$;

COMMIT;