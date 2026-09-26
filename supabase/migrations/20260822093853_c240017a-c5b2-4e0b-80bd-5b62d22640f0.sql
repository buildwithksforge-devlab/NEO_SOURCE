REVOKE ALL ON FUNCTION public.neo_guard_reporting_line() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_role_reporting_meta(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_role_reporting_meta(uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.neo_reporting_candidate_rows(uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_reporting_candidate_rows(uuid, uuid, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.neo_backfill_reporting_lines(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_backfill_reporting_lines(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.neo_reports_to_me(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reports_to_me(uuid) TO authenticated, service_role;