-- NEØ — Human Resources & Procurement department layers
-- Additive only: new functions, one segregation-of-duties guard, template top-ups.

-- 1. Procurement segregation of duties -------------------------------------
CREATE OR REPLACE FUNCTION public.neo_procurement_receiving_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_po record;
BEGIN
  IF NEW.order_id IS NULL THEN RETURN NEW; END IF;
  SELECT created_by, approved_by, prepared_by INTO v_po
    FROM public.purchase_orders WHERE id = NEW.order_id;
  IF v_po IS NULL THEN RETURN NEW; END IF;

  IF NEW.received_by IS NOT NULL
     AND NEW.received_by IN (v_po.created_by, v_po.approved_by, v_po.prepared_by)
     AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Separation of duties: the buyer who raised or approved this purchase order cannot receive it. Receiving belongs to the Receiving Clerk or Storekeeper.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_procurement_receiving_guard_trg ON public.goods_receipts;
CREATE TRIGGER neo_procurement_receiving_guard_trg
  BEFORE INSERT OR UPDATE OF received_by, order_id ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.neo_procurement_receiving_guard();

-- 2. HR — employment movement (promotion / transfer / role change) ----------
CREATE OR REPLACE FUNCTION public.neo_hr_employee_movement(
  _employee uuid,
  _change_type text,
  _effective_date date DEFAULT current_date,
  _reason text DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _job_title text DEFAULT NULL,
  _reporting_manager uuid DEFAULT NULL,
  _employment_status text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_emp record;
  v_prev jsonb;
  v_next jsonb;
BEGIN
  IF NOT (public.has_permission('human-resources','employees','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change employment records';
  END IF;
  IF _change_type NOT IN ('promotion','transfer','role-change','status-change','confirmation') THEN
    RAISE EXCEPTION 'Unknown employment change type';
  END IF;

  SELECT * INTO v_emp FROM public.employees
   WHERE id = _employee AND organization_id = v_org FOR UPDATE;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Unknown employee'; END IF;

  v_prev := jsonb_build_object(
    'branch_id', v_emp.branch_id, 'department_id', v_emp.department_id,
    'job_title', v_emp.job_title, 'reporting_manager_id', v_emp.reporting_manager_id,
    'employment_status', v_emp.employment_status);

  UPDATE public.employees SET
    branch_id = coalesce(_branch, branch_id),
    department_id = coalesce(_department, department_id),
    job_title = coalesce(nullif(trim(coalesce(_job_title,'')),''), job_title),
    reporting_manager_id = coalesce(_reporting_manager, reporting_manager_id),
    employment_status = coalesce(nullif(trim(coalesce(_employment_status,'')),''), employment_status),
    updated_at = now()
  WHERE id = _employee
  RETURNING jsonb_build_object(
    'branch_id', branch_id, 'department_id', department_id, 'job_title', job_title,
    'reporting_manager_id', reporting_manager_id, 'employment_status', employment_status)
  INTO v_next;

  -- Keep the linked NEØ profile's operational placement aligned. System roles
  -- and permissions are deliberately untouched — that is System Administration.
  IF v_emp.profile_id IS NOT NULL THEN
    UPDATE public.profiles
       SET branch_id = coalesce(_branch, branch_id),
           department_id = coalesce(_department, department_id),
           job_title = coalesce(nullif(trim(coalesce(_job_title,'')),''), job_title),
           updated_at = now()
     WHERE id = v_emp.profile_id;
  END IF;

  INSERT INTO public.employment_history
    (organization_id, employee_id, change_type, previous_value, new_value, effective_date, reason, requested_by)
  VALUES (v_org, _employee, _change_type, v_prev, v_next, coalesce(_effective_date, current_date), _reason, auth.uid());

  RETURN jsonb_build_object('ok', true, 'employee_id', _employee,
    'previous', v_prev, 'current', v_next,
    'access_review_required', (v_prev->>'department_id') IS DISTINCT FROM (v_next->>'department_id')
                              OR (v_prev->>'job_title') IS DISTINCT FROM (v_next->>'job_title'));
END $$;

-- 3. HR — employee documents ------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_document_record(
  _employee uuid,
  _category text,
  _title text,
  _storage_path text DEFAULT NULL,
  _issue_date date DEFAULT NULL,
  _expiry_date date DEFAULT NULL,
  _confidentiality text DEFAULT 'restricted'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_version integer;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission('human-resources','documents','create')
          OR public.has_permission('human-resources','employees','edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to manage employee documents';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = _employee AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Unknown employee';
  END IF;
  IF coalesce(trim(_title),'') = '' THEN RAISE EXCEPTION 'A document title is required'; END IF;

  SELECT coalesce(max(version),0) + 1 INTO v_version
    FROM public.employee_documents
   WHERE organization_id = v_org AND employee_id = _employee AND category = _category;

  -- Previous versions are superseded, never deleted.
  UPDATE public.employee_documents
     SET status = 'superseded', updated_at = now()
   WHERE organization_id = v_org AND employee_id = _employee
     AND category = _category AND status = 'active';

  INSERT INTO public.employee_documents
    (organization_id, employee_id, category, title, storage_path, issue_date, expiry_date,
     confidentiality, version, status, uploaded_by)
  VALUES (v_org, _employee, _category, trim(_title), _storage_path, _issue_date, _expiry_date,
     coalesce(nullif(trim(coalesce(_confidentiality,'')),''),'restricted'), v_version, 'active', auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'document_id', v_id, 'version', v_version);
END $$;

-- 4. HR — confidential employee relations cases -----------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_case_open(
  _kind text,
  _employee uuid,
  _subject text,
  _details text DEFAULT NULL,
  _case_type text DEFAULT 'general',
  _incident_date date DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _department uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_no text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission('human-resources','relations','create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to open employee relations cases';
  END IF;
  IF _kind NOT IN ('disciplinary','grievance') THEN RAISE EXCEPTION 'Unknown case kind'; END IF;
  IF coalesce(trim(_subject),'') = '' THEN RAISE EXCEPTION 'A case subject is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = _employee AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Unknown employee';
  END IF;

  v_no := upper(left(_kind,3)) || '-' || to_char(now(),'YYMM') || '-' ||
          lpad((floor(random()*9000)+1000)::text, 4, '0');

  IF _kind = 'disciplinary' THEN
    INSERT INTO public.disciplinary_cases
      (organization_id, branch_id, department_id, employee_id, case_number, case_type,
       incident_date, summary, status, opened_by)
    VALUES (v_org, _branch, _department, _employee, v_no, coalesce(_case_type,'general'),
       _incident_date, trim(_subject) || coalesce(E'\n' || _details, ''), 'open', auth.uid())
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.grievance_cases
      (organization_id, branch_id, department_id, raised_by_employee_id, case_number,
       subject, details, confidential, status, handled_by)
    VALUES (v_org, _branch, _department, _employee, v_no, trim(_subject), _details, true, 'open', auth.uid())
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'case_id', v_id, 'case_number', v_no, 'kind', _kind);
END $$;

CREATE OR REPLACE FUNCTION public.neo_hr_case_review(
  _kind text,
  _case uuid,
  _status text,
  _notes text DEFAULT NULL,
  _outcome text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
BEGIN
  IF NOT (public.has_permission('human-resources','relations','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to review employee relations cases';
  END IF;
  IF _kind NOT IN ('disciplinary','grievance') THEN RAISE EXCEPTION 'Unknown case kind'; END IF;
  IF _status NOT IN ('open','investigating','awaiting-response','closed') THEN
    RAISE EXCEPTION 'Unknown case status';
  END IF;

  IF _kind = 'disciplinary' THEN
    UPDATE public.disciplinary_cases
       SET status = _status,
           investigation_notes = coalesce(investigation_notes || E'\n', '') || coalesce(_notes,''),
           resolution = coalesce(_outcome, resolution),
           closed_at = CASE WHEN _status = 'closed' THEN now() ELSE closed_at END,
           updated_at = now()
     WHERE id = _case AND organization_id = v_org;
  ELSE
    UPDATE public.grievance_cases
       SET status = _status,
           investigation_notes = coalesce(investigation_notes || E'\n', '') || coalesce(_notes,''),
           outcome = coalesce(_outcome, outcome),
           closed_at = CASE WHEN _status = 'closed' THEN now() ELSE closed_at END,
           updated_at = now()
     WHERE id = _case AND organization_id = v_org;
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown case'; END IF;
  RETURN jsonb_build_object('ok', true, 'status', _status);
END $$;

-- 5. Execution grants -------------------------------------------------------
REVOKE ALL ON FUNCTION public.neo_hr_employee_movement(uuid, text, date, text, uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_hr_document_record(uuid, text, text, text, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_hr_case_open(text, uuid, text, text, text, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_hr_case_review(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_hr_employee_movement(uuid, text, date, text, uuid, uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_document_record(uuid, text, text, text, date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_case_open(text, uuid, text, text, text, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_case_review(text, uuid, text, text, text) TO authenticated;

-- 6. Feature templates ------------------------------------------------------
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'human-resources-manager', m, f, a FROM (VALUES
  ('human-resources','documents','view'), ('human-resources','documents','create'),
  ('human-resources','documents','edit'),
  ('human-resources','relations','view'), ('human-resources','relations','create'),
  ('human-resources','relations','edit'),
  ('human-resources','onboarding','view'), ('human-resources','onboarding','edit'),
  ('human-resources','movements','view'), ('human-resources','movements','create'),
  ('human-resources','supplies','view'), ('human-resources','supplies','create'),
  ('human-resources','tasks','view'), ('human-resources','tasks','create'),
  ('human-resources','reports','view'),
  ('stores','requisitions','view'), ('stores','requisitions','create')
) AS t(m,f,a)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates ft
   WHERE ft.role_key = 'human-resources-manager' AND ft.module = t.m AND ft.feature = t.f AND ft.action = t.a);

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'procurement-manager', m, f, a FROM (VALUES
  ('procurement','quotations','view'), ('procurement','quotations','create'),
  ('procurement','quotations','edit'),
  ('procurement','orders','view'), ('procurement','orders','create'), ('procurement','orders','edit'),
  ('procurement','tasks','view'), ('procurement','tasks','create'),
  ('procurement','supplies','view'), ('procurement','supplies','create'),
  ('procurement','reports','view'),
  ('stores','requisitions','view'), ('stores','requisitions','create')
) AS t(m,f,a)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates ft
   WHERE ft.role_key = 'procurement-manager' AND ft.module = t.m AND ft.feature = t.f AND ft.action = t.a);

DELETE FROM public.role_feature_templates
 WHERE role_key = 'procurement-manager' AND module = 'procurement' AND feature = 'receiving';

-- 7. Recompile every tenant's effective access ------------------------------
DO $$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(o);
  END LOOP;
END $$;
