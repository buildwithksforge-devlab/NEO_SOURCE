CREATE UNIQUE INDEX IF NOT EXISTS grounds_tasks_landscaping_occurrence_uniq
  ON public.grounds_tasks (organization_id, branch_id, schedule_id, service_date)
  WHERE schedule_id IS NOT NULL AND branch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_landscaping_generate_due()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_created integer := 0;
  v_existing integer := 0;
  v_sched public.landscaping_schedules%ROWTYPE;
  v_occurrence_date date;
BEGIN
  IF public.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'No active organisation';
  END IF;
  IF NOT public.has_permission('maintenance', 'landscaping', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to generate grounds work';
  END IF;

  FOR v_sched IN
    SELECT s.*
      FROM public.landscaping_schedules s
     WHERE s.organization_id = public.current_org_id()
       AND s.active
       AND s.next_due_date <= current_date
     ORDER BY s.next_due_date, s.id
     FOR UPDATE
  LOOP
    IF v_sched.branch_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.branches b
       WHERE b.id = v_sched.branch_id
         AND b.organization_id = v_sched.organization_id
    ) THEN
      RAISE EXCEPTION 'Landscaping schedule % is not attached to a valid property', v_sched.id;
    END IF;

    IF v_sched.area_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.grounds_areas a
       WHERE a.id = v_sched.area_id
         AND a.organization_id = v_sched.organization_id
         AND (a.branch_id IS NULL OR a.branch_id = v_sched.branch_id)
    ) THEN
      RAISE EXCEPTION 'Landscaping schedule % has an area outside its property', v_sched.id;
    END IF;

    IF v_sched.equipment_asset_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.assets a
       WHERE a.id = v_sched.equipment_asset_id
         AND a.organization_id = v_sched.organization_id
         AND (a.branch_id IS NULL OR a.branch_id = v_sched.branch_id)
    ) THEN
      RAISE EXCEPTION 'Landscaping schedule % has equipment outside its property', v_sched.id;
    END IF;

    v_occurrence_date := v_sched.next_due_date;

    INSERT INTO public.grounds_tasks (
      organization_id,
      branch_id,
      schedule_id,
      title,
      area_label,
      area_id,
      equipment_asset_id,
      instruction,
      priority,
      service_date,
      due_at,
      assignee_user_id,
      status,
      created_by
    ) VALUES (
      v_sched.organization_id,
      v_sched.branch_id,
      v_sched.id,
      v_sched.name,
      v_sched.area_label,
      v_sched.area_id,
      v_sched.equipment_asset_id,
      v_sched.instructions,
      'normal',
      v_occurrence_date,
      (v_occurrence_date + time '17:00')::timestamptz,
      v_sched.assignee_user_id,
      'not-started',
      auth.uid()
    )
    ON CONFLICT (organization_id, branch_id, schedule_id, service_date)
      WHERE schedule_id IS NOT NULL AND branch_id IS NOT NULL
    DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
    ELSE
      v_existing := v_existing + 1;
    END IF;

    UPDATE public.landscaping_schedules
       SET next_due_date = greatest(
             current_date + 1,
             v_occurrence_date + greatest(v_sched.interval_days, 1)
           )
     WHERE id = v_sched.id
       AND organization_id = v_sched.organization_id
       AND branch_id = v_sched.branch_id
       AND next_due_date = v_occurrence_date;
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'existing', v_existing);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_landscaping_generate_due() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_landscaping_generate_due() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_landscaping_generate_due() TO service_role;