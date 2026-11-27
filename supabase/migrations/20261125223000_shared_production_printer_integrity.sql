BEGIN;

-- ============================================================
-- 1. Configurable many-to-many production printer assignments.
-- Existing dedicated station printers remain supported.
-- ============================================================

CREATE TABLE public.neo_production_printer_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,
    branch_id uuid NOT NULL,

    printer_id uuid NOT NULL
        REFERENCES public.printer_profiles(id)
        ON DELETE CASCADE,

    station_id uuid NOT NULL
        REFERENCES public.operational_stations(id)
        ON DELETE CASCADE,

    active boolean NOT NULL DEFAULT true,

    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (organization_id,printer_id,station_id)
);

ALTER TABLE public.neo_production_printer_assignments
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_production_printer_assignments
FROM PUBLIC,anon,authenticated;

CREATE INDEX neo_production_printer_assignment_lookup
ON public.neo_production_printer_assignments (
    organization_id,
    branch_id,
    station_id,
    active
);


-- ============================================================
-- 2. Central printer-to-station eligibility.
-- ============================================================

CREATE FUNCTION public.neo_production_printer_matches_station(
    _printer uuid,
    _station uuid,
    _org uuid,
    _branch uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$

    SELECT EXISTS (
        SELECT 1

        FROM public.printer_profiles p

        JOIN public.operational_stations s
          ON s.id = _station
         AND s.organization_id = _org

        WHERE p.id = _printer

          AND p.organization_id = _org
          AND p.branch_id = _branch

          AND p.active IS TRUE
          AND s.active IS TRUE
          AND s.status = 'active'

          AND (
              s.branch_id IS NULL
              OR s.branch_id = _branch
          )

          AND lower(coalesce(p.printer_role,'')) IN (
              'production',
              'kitchen',
              'coffee',
              'bar',
              'pastry'
          )

          AND (
              p.station_id = _station

              OR EXISTS (
                  SELECT 1

                  FROM public.neo_production_printer_assignments a

                  WHERE a.organization_id = _org
                    AND a.branch_id = _branch
                    AND a.printer_id = _printer
                    AND a.station_id = _station
                    AND a.active IS TRUE
              )
          )
    );

$function$;

REVOKE ALL ON FUNCTION
public.neo_production_printer_matches_station(
    uuid,uuid,uuid,uuid
)
FROM PUBLIC,anon,authenticated;


-- ============================================================
-- 3. Controlled shared printer configuration.
-- ============================================================

CREATE FUNCTION public.neo_configure_production_printer(
    _printer uuid,
    _stations uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    p public.printer_profiles;
    v_station uuid;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_org_admin() IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Printer configuration requires workspace administrator access'
            USING ERRCODE = '42501';
    END IF;

    IF _stations IS NULL
       OR cardinality(_stations) > 100
       OR array_position(_stations,NULL::uuid) IS NOT NULL
    THEN
        RAISE EXCEPTION 'Invalid station configuration';
    END IF;

    SELECT * INTO p

    FROM public.printer_profiles

    WHERE id = _printer
      AND organization_id = v_org
      AND active IS TRUE

    FOR UPDATE;

    IF NOT FOUND
       OR p.branch_id IS NULL
       OR public.neo_branch_in_scope(p.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Printer is outside the authorised property';
    END IF;

    IF lower(coalesce(p.printer_role,'')) NOT IN (
        'production','kitchen','coffee','bar','pastry'
    ) THEN
        RAISE EXCEPTION
            'Only production printers support shared production assignments';
    END IF;

    FOREACH v_station IN ARRAY _stations LOOP

        IF NOT EXISTS (
            SELECT 1

            FROM public.operational_stations s

            WHERE s.id = v_station
              AND s.organization_id = v_org
              AND s.active IS TRUE
              AND s.status = 'active'

              AND (
                  s.branch_id IS NULL
                  OR s.branch_id = p.branch_id
              )
        ) THEN
            RAISE EXCEPTION
                'Selected station is inactive or outside the property';
        END IF;

    END LOOP;

    UPDATE public.neo_production_printer_assignments

       SET active = false

     WHERE organization_id = v_org
       AND printer_id = p.id
       AND NOT (station_id = ANY(_stations));

    INSERT INTO public.neo_production_printer_assignments (
        organization_id,
        branch_id,
        printer_id,
        station_id,
        active,
        created_by
    )
    SELECT
        v_org,
        p.branch_id,
        p.id,
        station_id,
        true,
        auth.uid()

    FROM (
        SELECT DISTINCT unnest(_stations) AS station_id
    ) selected

    ON CONFLICT (organization_id,printer_id,station_id)

    DO UPDATE SET
        active = true,
        branch_id = EXCLUDED.branch_id;

    RETURN jsonb_build_object(
        'ok',true,
        'printer_id',p.id,
        'station_ids',(
            SELECT coalesce(
                jsonb_agg(a.station_id ORDER BY a.station_id),
                '[]'::jsonb
            )

            FROM public.neo_production_printer_assignments a

            WHERE a.organization_id = v_org
              AND a.printer_id = p.id
              AND a.active
        )
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_configure_production_printer(uuid,uuid[])
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_configure_production_printer(uuid,uuid[])
TO authenticated;


-- ============================================================
-- 4. Extend existing print-job validation.
-- Preserve all existing workspace, branch and receipt checks.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_print_validate_job()'::regprocedure
    );

    anchor :=
        'v_printer.station_id IS DISTINCT FROM v_station';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN

        RAISE EXCEPTION
            'Existing print validation contract differs';

    END IF;

    d := replace(
        d,
        anchor,
        $patch$
        NOT public.neo_production_printer_matches_station(
            v_printer.id,
            v_station,
            NEW.organization_id,
            NEW.branch_id
        )
$patch$
    );

    EXECUTE d;

END;
$migration$;


-- ============================================================
-- 5. Durable evidence of newly queued production items.
--
-- An item is recorded once per production ticket.
-- This does not claim that physical printing has succeeded.
-- ============================================================

CREATE TABLE public.neo_production_print_item_evidence (
    organization_id uuid NOT NULL,

    ticket_id uuid NOT NULL,

    ticket_item_id uuid NOT NULL,

    print_job_id uuid NOT NULL,

    queued_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (
        organization_id,
        ticket_id,
        ticket_item_id
    )
);

ALTER TABLE public.neo_production_print_item_evidence
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_production_print_item_evidence
FROM PUBLIC,anon,authenticated;


-- ============================================================
-- 6. Update canonical production print queue.
--
-- Preserve existing document formatting, printer health
-- ordering, retry configuration and print-agent lifecycle.
-- ============================================================

DO $migration$
DECLARE
    d text;
    anchor text;
BEGIN

    d := pg_get_functiondef(
        'public.neo_print_queue_station_tickets(uuid,uuid)'
        ::regprocedure
    );

    anchor := '  v_idempotency text;';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Print queue declaration differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
  v_idempotency text;
  v_pending_items uuid[];
$patch$
    );

    -- Serialize queue creation for the same order.

    anchor := $anchor$
BEGIN
  FOR v_ticket IN
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Print queue entry differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
BEGIN

  PERFORM pg_advisory_xact_lock(
      hashtextextended(
          _org::text || ':production-print:' || _order::text,
          0
      )
  );

  FOR v_ticket IN
$patch$
    );

    -- Select production items not previously queued by
    -- the incremental print mechanism.

    anchor := $anchor$
    v_idempotency :=
      'production-ticket:' || v_ticket.ticket_id::text;
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Print identity contract differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$

    v_job := NULL;
    v_printer := NULL;
    v_pending_items := ARRAY[]::uuid[];

    -- Older print jobs did not retain individual ticket
    -- item identities. Do not guess which lines they printed.

    -- Legacy print coverage is evaluated per production item.

    SELECT coalesce(
        array_agg(ti.id ORDER BY ti.id),
        ARRAY[]::uuid[]
    )

    INTO v_pending_items

    FROM public.station_ticket_items ti

    JOIN public.pos_order_items oi
      ON oi.id = ti.order_item_id
     AND oi.organization_id = ti.organization_id
     AND oi.order_id = _order

    WHERE ti.organization_id = _org
      AND ti.ticket_id = v_ticket.ticket_id
      -- neo_legacy_incremental_print_boundary_v1

      AND NOT EXISTS (

          SELECT 1

          FROM public.print_jobs legacy

          WHERE legacy.organization_id = _org

            AND legacy.idempotency_key =
                'production-ticket:' ||
                v_ticket.ticket_id::text

            AND (

                ti.created_at IS NULL

                OR legacy.created_at IS NULL

                OR ti.created_at <= legacy.created_at

            )

      )

      AND ti.status IN (
          'new','accepted','preparing',
          'remake-requested','remaking'
      )

      AND oi.status NOT IN (
          'voided','cancelled','cancel-pending'
      )

      AND NOT EXISTS (
          SELECT 1

          FROM public.neo_production_print_item_evidence e

          WHERE e.organization_id = _org
            AND e.ticket_id = ti.ticket_id
            AND e.ticket_item_id = ti.id
      );

    IF cardinality(v_pending_items) = 0 THEN
        v_already := v_already + 1;
        CONTINUE;
    END IF;

    v_idempotency :=
        'production-ticket-items:' ||
        v_ticket.ticket_id::text ||
        ':' ||
        md5(array_to_string(v_pending_items,','));

$patch$
    );

    -- Allow explicitly configured shared printers.

    anchor :=
        'AND p.station_id = v_ticket.station_id';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Printer selection contract differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
      AND public.neo_production_printer_matches_station(
          p.id,
          v_ticket.station_id,
          _org,
          v_ticket.branch_id
      )
$patch$
    );

    -- Prefer an existing dedicated printer when equally healthy.

    anchor := $anchor$
      p.created_at,
      p.id
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Printer priority contract differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
      CASE
          WHEN p.station_id = v_ticket.station_id THEN 0
          ELSE 1
      END,
      p.created_at,
      p.id
$patch$
    );

    -- Print only the new production lines.

    anchor := $anchor$
            AND oi.status <> 'voided'
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Production print line filter differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
            AND ti.id = ANY(v_pending_items)
            AND oi.organization_id = _org
            AND oi.order_id = _order
            AND oi.status NOT IN (
                'voided','cancelled','cancel-pending'
            )
$patch$
    );

    -- Retain exact production line identities in the payload.

    anchor := '''lines'', v_lines';

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Print payload contract differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$
        'ticket_item_ids',to_jsonb(v_pending_items),
        'lines',v_lines
$patch$
    );

    -- Evidence and queued print job are committed together.

    anchor := $anchor$
      v_queued := v_queued + 1;
$anchor$;

    IF (
        length(d) -
        length(replace(d,anchor,''))
    ) <> length(anchor) THEN
        RAISE EXCEPTION 'Print queue confirmation differs';
    END IF;

    d := replace(
        d,
        anchor,
        $patch$

      IF v_job IS NULL THEN
          RAISE EXCEPTION
              'Production print evidence requires a saved job';
      END IF;

      INSERT INTO public.neo_production_print_item_evidence (
          organization_id,
          ticket_id,
          ticket_item_id,
          print_job_id
      )

      SELECT
          _org,
          v_ticket.ticket_id,
          item_id,
          v_job

      FROM unnest(v_pending_items) AS items(item_id)

      ON CONFLICT (
          organization_id,
          ticket_id,
          ticket_item_id
      )
      DO NOTHING;

      v_queued := v_queued + 1;

$patch$
    );

    EXECUTE d;

END;
$migration$;

CREATE FUNCTION public.neo_get_production_printer_assignments(
    _printer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    p public.printer_profiles;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_org_admin() IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Printer configuration requires administrator access'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO p

    FROM public.printer_profiles

    WHERE id = _printer
      AND organization_id = v_org
      AND active IS TRUE;

    IF NOT FOUND
       OR p.branch_id IS NULL
       OR public.neo_branch_in_scope(p.branch_id) IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Printer is outside the authorised property'
            USING ERRCODE = '42501';
    END IF;

    RETURN (
        SELECT coalesce(
            jsonb_agg(a.station_id ORDER BY a.station_id),
            '[]'::jsonb
        )

        FROM public.neo_production_printer_assignments a

        WHERE a.organization_id = v_org
          AND a.branch_id = p.branch_id
          AND a.printer_id = p.id
          AND a.active IS TRUE
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_get_production_printer_assignments(uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_get_production_printer_assignments(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;