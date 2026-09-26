-- The operational facts routine counted readiness against `room_condition`
-- ('vacant-clean', 'vacant-dirty', ...) using the values of the *housekeeping*
-- axis ('clean', 'dirty'), so Ready rooms and Dirty rooms were always zero while
-- the Housekeeping board — which reads `housekeeping_state` — showed the truth.
-- Patch only those two expressions, leaving the rest of the routine untouched.
DO $$
DECLARE
  def text;
  patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'neo_operational_facts';

  IF def IS NULL THEN
    RAISE EXCEPTION 'public.neo_operational_facts() not found';
  END IF;

  patched := replace(
    def,
    'WHERE s.room_condition = ''dirty''',
    'WHERE s.housekeeping_state IN (''dirty'',''cleaning_queued'')'
  );
  patched := replace(
    patched,
    'WHERE s.room_condition = ''clean'' AND s.occupancy_status <> ''occupied''',
    'WHERE s.housekeeping_state = ''ready'' AND s.occupancy_status <> ''occupied'''
  );

  IF patched = def THEN
    RAISE EXCEPTION 'expected readiness expressions were not found — not patching';
  END IF;

  EXECUTE patched;
END $$;