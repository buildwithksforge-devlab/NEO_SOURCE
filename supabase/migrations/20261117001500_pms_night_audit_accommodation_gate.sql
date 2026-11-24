-- NEØ Cell 01-D2: Block audit/day close on missing accommodation.
-- STAGED ONLY. No accommodation posting, backfill, or financial mutation.
BEGIN;

DO $repair$
DECLARE
    audit_fn regprocedure :=
      to_regprocedure('public.neo_night_audit_run(uuid,date,text)');
    close_fn regprocedure :=
      to_regprocedure('public.neo_close_business_day(uuid,date,text)');
    helper_fn regprocedure :=
      to_regprocedure('public.neo_pms_missing_accommodation(uuid,uuid,date)');
    definition text;
    old_text text;
    new_text text;
    fn regprocedure;
    old_owner oid;
    old_acl aclitem[];
    n integer;
BEGIN
    IF audit_fn IS NULL OR close_fn IS NULL OR helper_fn IS NULL THEN
        RAISE EXCEPTION 'Required Night Audit, close, or helper function missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = helper_fn
          AND prosecdef = false
          AND provolatile = 's'
    ) THEN
        RAISE EXCEPTION 'Missing accommodation helper security differs';
    END IF;

    -- Insert the missing-charge check before other canonical finance checks.
    fn := audit_fn;

    SELECT pg_get_functiondef(fn), proowner, proacl
      INTO definition, old_owner, old_acl
    FROM pg_proc WHERE oid=fn;

    IF position('night_audit_exceptions' IN definition)=0
       OR position('neo_finance_exception_register' IN definition)=0
       OR position('neo_finance_posting_queue' IN definition)=0
       OR position('CASE WHEN blockers > 0' IN definition)=0
    THEN
        RAISE EXCEPTION 'Installed Night Audit differs from reviewed contract';
    END IF;

    old_text := '    -- CANONICAL FINANCE EXCEPTIONS: blocking.';

    new_text := $audit$
    -- IN-HOUSE ACCOMMODATION NOT POSTED: blocking.
    -- This is inspection-only and never creates a folio line.
    INSERT INTO public.night_audit_exceptions(
      run_id,organization_id,branch_id,business_date,
      category,severity,reference,detail,amount
    )
    SELECT
      rid,org,_branch,d,
      'missing-accommodation','blocking',
      m.reference,
      'In-house accommodation charge missing or attached to an invalid guest folio.',
      m.amount
    FROM public.neo_pms_missing_accommodation(org,_branch,d) m;

    -- CANONICAL FINANCE EXCEPTIONS: blocking.$audit$;

    n := (length(definition)-length(replace(definition,old_text,'')))
         / length(old_text);

    IF n <> 1 THEN
        RAISE EXCEPTION 'Night Audit insertion anchor differs: % matches',n;
    END IF;

    EXECUTE replace(definition,old_text,new_text);

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid=fn AND proowner=old_owner
          AND proacl IS NOT DISTINCT FROM old_acl
          AND position('missing-accommodation' IN prosrc)>0
    ) THEN
        RAISE EXCEPTION 'Night Audit ownership, ACL or integration verification failed';
    END IF;

    -- Independently check the live state before the actual day close.
    -- A previously signed audit cannot bypass this condition.
    fn := close_fn;

    SELECT pg_get_functiondef(fn), proowner, proacl
      INTO definition, old_owner, old_acl
    FROM pg_proc WHERE oid=fn;

    IF position('night_audit_runs' IN definition)=0
       OR position('business_days' IN definition)=0
       OR position('neo_finance_exception_register' IN definition)=0
       OR position('neo_finance_posting_queue' IN definition)=0
    THEN
        RAISE EXCEPTION 'Installed close-day function differs from reviewed contract';
    END IF;

    old_text := 'SELECT[[:space:]]+count[(][*][)][[:space:]]+INTO[[:space:]]+_unresolved[[:space:]]+FROM[[:space:]]+public[.]neo_finance_exception_register[(]_branch,[[:space:]]*_d,[[:space:]]*_d[)];';

    new_text := $close$
   -- Live accommodation reconciliation, independent of prior audit snapshot.
   IF EXISTS (
     SELECT 1
     FROM public.neo_pms_missing_accommodation(_org,_branch,_d)
   ) THEN
     RETURN jsonb_build_object(
       'status','exception',
       'business_date',_d,
       'blocking',(
         SELECT count(*)
         FROM public.neo_pms_missing_accommodation(_org,_branch,_d)
       ),
       'message','Missing accommodation charges must be reconciled before closing the business day.'
     );
   END IF;

   SELECT count(*) INTO _unresolved FROM public.neo_finance_exception_register(_branch,_d,_d);$close$;

    SELECT count(*) INTO n
    FROM regexp_matches(definition,old_text,'g');

    IF n <> 1 THEN
        RAISE EXCEPTION 'Business-day close insertion anchor differs: % matches',n;
    END IF;

    EXECUTE regexp_replace(definition,old_text,new_text);

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid=fn AND proowner=old_owner
          AND proacl IS NOT DISTINCT FROM old_acl
          AND position('neo_pms_missing_accommodation' IN prosrc)>0
    ) THEN
        RAISE EXCEPTION 'Day-close ownership, ACL or integration verification failed';
    END IF;
END;
$repair$;

COMMIT;