-- NEØ Cell 01-D2: Property-scoped deposit application
-- LOCAL CANDIDATE ONLY.
BEGIN;

DO $repair$
DECLARE
    fn regprocedure :=
      to_regprocedure('public.pms_apply_deposits_to_folio()');
    definition text;
    anchor text :=
      'WHERE reservation_id = NEW.reservation_id AND status = ''held''';
    replacement text :=
      'WHERE reservation_id = NEW.reservation_id
         AND organization_id = NEW.organization_id
         AND branch_id IS NOT DISTINCT FROM NEW.branch_id
         AND status = ''held''';
BEGIN
    IF fn IS NULL THEN
        RAISE EXCEPTION 'Deposit application trigger function missing';
    END IF;

    SELECT pg_get_functiondef(fn) INTO definition;

    IF definition IS NULL OR
       length(definition) - length(replace(definition,anchor,''))
       <> length(anchor) THEN
        RAISE EXCEPTION
          'Installed deposit application differs from reviewed source';
    END IF;

    IF position('applied_folio_line_id' IN definition)=0
       OR position('total_payments' IN definition)=0 THEN
        RAISE EXCEPTION
          'Deposit application contract differs from reviewed source';
    END IF;

    definition := replace(definition,anchor,replacement);
    EXECUTE definition;

    SELECT pg_get_functiondef(fn) INTO definition;

    IF position(
      'branch_id IS NOT DISTINCT FROM NEW.branch_id'
      IN definition
    )=0 THEN
        RAISE EXCEPTION 'Deposit property-scope installation failed';
    END IF;
END;
$repair$;

COMMIT;