GRANT EXECUTE ON FUNCTION public.neo_event_workspace(uuid, date, date) TO postgres;
GRANT EXECUTE ON FUNCTION public.events_metrics(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.events_department_readiness(uuid) TO postgres;