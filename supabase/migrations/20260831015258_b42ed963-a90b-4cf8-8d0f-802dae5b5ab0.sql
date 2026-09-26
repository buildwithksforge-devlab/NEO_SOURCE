-- The supersede rule linked the older job to NEW.id while the new row did not yet
-- exist (BEFORE INSERT), so housekeeping_jobs_superseded_by_fkey failed and the
-- whole check-out transaction rolled back. Running it AFTER INSERT keeps exactly
-- one active cleaning job per room and always leaves a valid replacement link.
DROP TRIGGER IF EXISTS housekeeping_single_active_room_job ON public.housekeeping_jobs;

CREATE TRIGGER housekeeping_single_active_room_job
AFTER INSERT ON public.housekeeping_jobs
FOR EACH ROW EXECUTE FUNCTION public.tg_housekeeping_single_active_room_job();