-- NEØ Cell 01-D2: Check-in room property ownership
-- LOCAL CANDIDATE. No historical data mutation.
BEGIN;

DO $repair$
DECLARE
  fn regprocedure :=
    to_regprocedure('public.pms_check_in(uuid,integer,text)');
  definition text;
  anchor text := 'WHERE id=_res.room_id FOR UPDATE;';
  replacement text := $code$
WHERE id=_res.room_id
      AND organization_id=_org
      AND branch_id=_res.branch_id
    FOR UPDATE;

  IF _room.id IS NULL THEN
    RAISE EXCEPTION
      'Assigned room is missing or belongs to another property'
      USING ERRCODE = '22023';
  END IF;
$code$;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'Expected PMS check-in function is missing';
  END IF;

  SELECT pg_get_functiondef(fn) INTO definition;

  IF definition IS NULL
     OR length(definition)-length(replace(definition,anchor,''))
        <> length(anchor)
     OR position('Reservation not found' IN definition)=0
     OR position('Assign a room before check-in' IN definition)=0
     OR position('Check-in is not permitted before the reservation arrival date' IN definition)=0
  THEN
    RAISE EXCEPTION
      'Installed check-in function differs from reviewed guarded version';
  END IF;

  IF position(
    'Assigned room is missing or belongs to another property'
    IN definition
  ) > 0 THEN
    RAISE EXCEPTION 'Check-in room property guard is already installed';
  END IF;

  definition := replace(definition,anchor,replacement);
  EXECUTE definition;

  SELECT pg_get_functiondef(fn) INTO definition;

  IF position(
    'Assigned room is missing or belongs to another property'
    IN definition
  ) = 0 THEN
    RAISE EXCEPTION 'Check-in room property guard installation failed';
  END IF;
END;
$repair$;

COMMIT;