-- Code-only guard installation. Existing requirements and tasks are not rewritten.
BEGIN;
DO $guard$
BEGIN
 IF to_regprocedure('public.neo_event_requirement_ownership_guard()') IS NOT NULL THEN
   RAISE EXCEPTION 'Event requirement ownership guard already exists; inspect installed code first.';
 END IF;
 IF to_regclass('public.event_department_requirements') IS NULL
 OR to_regclass('public.event_bookings') IS NULL OR to_regclass('public.departments') IS NULL
 OR to_regclass('public.tasks') IS NULL THEN RAISE EXCEPTION 'Event ownership contracts are missing'; END IF;
END $guard$;

CREATE FUNCTION public.neo_event_requirement_ownership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE booking public.event_bookings; owner public.departments; linked public.tasks;
        key text; candidates uuid[]; preferred boolean;
BEGIN
 SELECT * INTO booking FROM public.event_bookings WHERE id=NEW.booking_id FOR SHARE;
 IF booking.id IS NULL OR booking.organization_id IS DISTINCT FROM NEW.organization_id
 OR booking.organization_id IS DISTINCT FROM public.current_org_id() THEN
   RAISE EXCEPTION 'The event requirement must belong to a booking in this workspace' USING ERRCODE='42501';
 END IF;
 IF booking.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(booking.branch_id),false)
 OR (NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM booking.branch_id) THEN
   RAISE EXCEPTION 'The requirement property must match the event and your access scope' USING ERRCODE='42501';
 END IF;
 NEW.branch_id:=booking.branch_id;
 IF NEW.department_id IS NULL THEN
   key:=upper(replace(replace(btrim(coalesce(NEW.department_key,'')),'-','_'),' ','_'));
   -- Exact configured code/name, plus the existing BEO KITC -> KITC/REST/FNB rule.
   -- Prefer a property department over shared configuration; refuse ambiguous ownership.
   SELECT coalesce(bool_or(d.branch_id=booking.branch_id),false) INTO preferred
     FROM public.departments d WHERE d.organization_id=booking.organization_id AND d.active
      AND (d.branch_id=booking.branch_id OR d.branch_id IS NULL)
      AND (upper(coalesce(d.code,''))=key
       OR upper(replace(replace(d.name,'-','_'),' ','_'))=key
       OR (key='KITC' AND upper(coalesce(d.code,'')) IN ('REST','FNB')));
   SELECT array_agg(d.id ORDER BY d.id) INTO candidates
     FROM public.departments d WHERE d.organization_id=booking.organization_id AND d.active
      AND (CASE WHEN preferred THEN d.branch_id=booking.branch_id ELSE d.branch_id IS NULL END)
      AND (upper(coalesce(d.code,''))=key
       OR upper(replace(replace(d.name,'-','_'),' ','_'))=key
       OR (key='KITC' AND upper(coalesce(d.code,'')) IN ('REST','FNB')));
   IF coalesce(array_length(candidates,1),0)<>1 THEN
     RAISE EXCEPTION 'Choose one active configured department for this event requirement; automatic ownership is missing or ambiguous' USING ERRCODE='23514';
   END IF;
   NEW.department_id:=candidates[1];
 END IF;
 SELECT * INTO owner FROM public.departments WHERE id=NEW.department_id FOR SHARE;
 IF owner.id IS NULL OR owner.organization_id IS DISTINCT FROM booking.organization_id
 OR NOT coalesce(owner.active,false)
 OR (owner.branch_id IS NOT NULL AND owner.branch_id IS DISTINCT FROM booking.branch_id) THEN
   RAISE EXCEPTION 'Choose an active department belonging to this event property or shared workspace configuration' USING ERRCODE='23514';
 END IF;
 IF NEW.task_id IS NOT NULL THEN
   SELECT * INTO linked FROM public.tasks WHERE id=NEW.task_id FOR SHARE;
   IF linked.id IS NULL OR linked.organization_id IS DISTINCT FROM booking.organization_id
    OR linked.branch_id IS DISTINCT FROM booking.branch_id
    OR linked.department_id IS DISTINCT FROM NEW.department_id THEN
     RAISE EXCEPTION 'The linked event task must have the same workspace, property and department' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_event_requirement_ownership_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER neo_event_requirement_ownership
 BEFORE INSERT OR UPDATE OF organization_id,branch_id,booking_id,department_id,department_key,task_id
 ON public.event_department_requirements FOR EACH ROW EXECUTE FUNCTION public.neo_event_requirement_ownership_guard();
COMMIT;
