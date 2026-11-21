-- Route station production tickets to every supported local connector type.
-- Station mapping takes precedence over department mapping.
-- Receipt printers are excluded from automatic production printing.

CREATE OR REPLACE FUNCTION public.neo_print_station_printer(
    _ticket public.station_tickets
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT p.id
    FROM public.printer_profiles p
    WHERE p.organization_id = _ticket.organization_id
      AND p.branch_id = _ticket.branch_id
      AND p.active
      AND p.connection_type IN (
          'network',
          'windows_spooler',
          'bluetooth_classic'
      )
      AND p.printer_role <> 'receipt'
      AND (
          (
              _ticket.station_id IS NOT NULL
              AND p.station_id = _ticket.station_id
          )
          OR (
              p.station_id IS NULL
              AND _ticket.department_id IS NOT NULL
              AND p.department_id = _ticket.department_id
          )
      )
    ORDER BY
        (p.station_id IS NOT DISTINCT FROM _ticket.station_id) DESC,
        p.created_at,
        p.id
    LIMIT 1
$$;

REVOKE ALL
ON FUNCTION public.neo_print_station_printer(public.station_tickets)
FROM PUBLIC, anon, authenticated;