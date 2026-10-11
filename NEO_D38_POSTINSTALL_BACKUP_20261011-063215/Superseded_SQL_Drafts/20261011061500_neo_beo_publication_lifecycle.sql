-- ============================================================
-- NEØ D38 — BEO PUBLICATION AND READINESS LIFECYCLE
--
-- Assumes the earlier neo_beo_revise migration is applied first.
--
-- This migration patches the currently installed definitions.
-- It fails rather than silently replacing an unexpected version.
--
-- All statements execute transactionally when applied through
-- the Supabase migration runner.
-- ============================================================

DO $migration$
DECLARE
    publish_source text;
    chain_source text;
    needle text;
    replacement text;
BEGIN

    -- ========================================================
    -- A. RETRIEVE CURRENT PUBLISH FUNCTION
    -- ========================================================

    SELECT pg_get_functiondef(
        'public.neo_event_beo_publish(uuid)'::regprocedure
    )
    INTO publish_source;

    IF publish_source IS NULL THEN
        RAISE EXCEPTION
            'D38: Existing BEO publish function not found.';
    END IF;

    -- ========================================================
    -- B. LOCK EVENT AND PROTECT INVALID REPUBLICATION
    -- ========================================================

    needle :=
        'IF o.id IS NULL THEN RAISE EXCEPTION ' ||
        quote_literal('Banquet event order not found') ||
        '; END IF;';

    replacement :=
        needle || E'\n' ||
        $patch$
  -- Serialize publishing for all BEO revisions of this event.
  PERFORM 1
  FROM public.event_bookings
  WHERE id = o.booking_id
    AND organization_id = o.organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The event booking no longer exists';
  END IF;

  IF o.status IN ('superseded', 'cancelled') THEN
    RAISE EXCEPTION
      'A superseded or cancelled BEO cannot be published';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.banquet_event_orders newer
    WHERE newer.booking_id = o.booking_id
      AND newer.organization_id = o.organization_id
      AND newer.revision > o.revision
      AND newer.status = 'published'
  ) THEN
    RAISE EXCEPTION
      'A newer published BEO already exists for this event';
  END IF;
$patch$;

    IF length(publish_source) -
       length(replace(publish_source, needle, ''))
       <> length(needle) THEN
        RAISE EXCEPTION
            'D38: Publish function guard has changed.';
    END IF;

    publish_source :=
        replace(publish_source, needle, replacement);

    -- ========================================================
    -- C. PRESERVE EXISTING VENUE PREPARATION JOB
    --
    -- Existing jobs may use beo:<old BEO id>.
    -- We search by the stable event booking instead.
    -- ========================================================

    needle :=
        'WHERE organization_id = b.organization_id AND idempotency_key = ' ||
        quote_literal('beo:') ||
        ' || _beo::text;';

    replacement :=
        $patch$
WHERE organization_id = b.organization_id
      AND source = 'events'
      AND source_record_id = b.id
      AND job_type = 'event-preparation'
    ORDER BY created_at ASC
    LIMIT 1;
$patch$;

    IF length(publish_source) -
       length(replace(publish_source, needle, ''))
       <> length(needle) THEN
        RAISE EXCEPTION
            'D38: Housekeeping lookup differs from expected implementation.';
    END IF;

    publish_source :=
        replace(publish_source, needle, replacement);

    -- ========================================================
    -- D. USE STABLE EVENT KEY FOR NEW JOBS
    --
    -- Historical BEO-keyed jobs remain untouched.
    -- ========================================================

    needle :=
        quote_literal('events') ||
        ', b.id, ' ||
        quote_literal('beo:') ||
        ' || _beo::text, auth.uid()';

    replacement :=
        quote_literal('events') ||
        ', b.id, ' ||
        quote_literal('event-preparation:') ||
        ' || b.id::text, auth.uid()';

    IF length(publish_source) -
       length(replace(publish_source, needle, ''))
       <> length(needle) THEN
        RAISE EXCEPTION
            'D38: Housekeeping idempotency key differs from expected implementation.';
    END IF;

    publish_source :=
        replace(publish_source, needle, replacement);

    -- ========================================================
    -- E. SUPERSEDE PREVIOUS PUBLISHED REVISION
    --
    -- This runs after existing departmental handoffs.
    -- Any uncaught SQL error rolls back the publication.
    -- ========================================================

    needle :=
        'RETURN jsonb_build_object(';

    replacement :=
        $patch$
  -- A replacement becomes operational only after publication.
  -- The previous published BEO is retired in this transaction.
  UPDATE public.banquet_event_orders previous
     SET status = 'superseded',
         updated_by = auth.uid(),
         updated_at = now()
   WHERE previous.organization_id = o.organization_id
     AND previous.booking_id = o.booking_id
     AND previous.id <> _beo
     AND previous.status = 'published'
     AND previous.revision < o.revision;

  RETURN jsonb_build_object(
$patch$;

    IF length(publish_source) -
       length(replace(publish_source, needle, ''))
       <> length(needle) THEN
        RAISE EXCEPTION
            'D38: Publish return structure differs from expected implementation.';
    END IF;

    publish_source :=
        replace(publish_source, needle, replacement);

    -- Keep the existing publication routine, including:
    -- * departmental requirements
    -- * departmental acknowledgements
    -- * housekeeping preparation
    -- * billing handoff
    -- * event notifications
    -- * September 14 null-setup correction

    EXECUTE publish_source;

    -- ========================================================
    -- F. RETRIEVE LATEST EVENT CHAIN FUNCTION
    -- ========================================================

    SELECT pg_get_functiondef(
        'public.neo_event_chain_status(uuid)'::regprocedure
    )
    INTO chain_source;

    IF chain_source IS NULL THEN
        RAISE EXCEPTION
            'D38: Event Chain Status function not found.';
    END IF;

    -- ========================================================
    -- G. PRIORITISE OPERATIONAL PUBLISHED BEO
    --
    -- Previously: latest non-superseded revision.
    --
    -- Now:
    -- 1. Published revision
    -- 2. Latest non-cancelled working revision
    -- 3. Historical fallback
    -- ========================================================

    needle :=
        'WHERE x.booking_id = b.id AND x.status <> ' ||
        quote_literal('superseded') ||
        E'\n' ||
        '        ORDER BY x.revision DESC LIMIT 1';

    replacement :=
        $patch$
WHERE x.booking_id = b.id
        ORDER BY
          CASE
            WHEN x.status = 'published' THEN 0
            WHEN x.status NOT IN ('superseded', 'cancelled') THEN 1
            ELSE 2
          END,
          x.revision DESC
        LIMIT 1
$patch$;

    IF position(needle IN chain_source) = 0 THEN
        RAISE EXCEPTION
            'D38: Event Chain Status selection differs from expected implementation.';
    END IF;

    chain_source :=
        replace(chain_source, needle, replacement);

    EXECUTE chain_source;

END;
$migration$;