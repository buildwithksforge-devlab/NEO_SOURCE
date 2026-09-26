-- =====================================================================
-- PHASE 13 — HUMAN RESOURCES & WORKFORCE MANAGEMENT (schema + RLS)
-- =====================================================================

-- ---------- CORE EMPLOYEE TABLES -------------------------------------
CREATE TABLE public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  employee_number text NOT NULL,
  full_name text NOT NULL,
  preferred_name text NOT NULL DEFAULT '',
  avatar_url text,
  date_of_birth date,
  gender text,
  nationality text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  personal_email text NOT NULL DEFAULT '',
  work_email text NOT NULL DEFAULT '',
  physical_address text NOT NULL DEFAULT '',
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.operational_stations(id) ON DELETE SET NULL,
  job_title text NOT NULL DEFAULT '',
  position_grade text NOT NULL DEFAULT '',
  employment_type text NOT NULL DEFAULT 'permanent',
  employment_status text NOT NULL DEFAULT 'active',
  employment_date date,
  confirmation_date date,
  probation_end_date date,
  contract_start date,
  contract_end date,
  reporting_manager_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  work_location text NOT NULL DEFAULT '',
  default_shift_template_id uuid,
  payroll_status text NOT NULL DEFAULT 'not_ready',
  system_access_status text NOT NULL DEFAULT 'none',
  candidate_id uuid,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, employee_number)
);
CREATE INDEX employees_org_idx ON public.employees (organization_id, employment_status);
CREATE INDEX employees_dept_idx ON public.employees (department_id);
CREATE INDEX employees_branch_idx ON public.employees (branch_id);
CREATE UNIQUE INDEX employees_profile_uniq ON public.employees (profile_id) WHERE profile_id IS NOT NULL;

-- ---------- HELPER FUNCTIONS -----------------------------------------
CREATE OR REPLACE FUNCTION public.hr_my_employee_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id FROM public.employees e
  WHERE e.profile_id = auth.uid() AND e.organization_id = public.current_org_id()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.hr_my_department_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT department_id FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.hr_is_self(_employee uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _employee IS NOT NULL AND _employee = public.hr_my_employee_id();
$$;

-- Direct report or same-department employee (team scope for supervisors/managers).
CREATE OR REPLACE FUNCTION public.hr_is_team_member(_employee uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = _employee
      AND e.organization_id = public.current_org_id()
      AND (
        e.reporting_manager_id = public.hr_my_employee_id()
        OR (e.department_id IS NOT NULL AND e.department_id = public.hr_my_department_id())
      )
  );
$$;

CREATE TABLE public.employee_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL UNIQUE REFERENCES public.employees(id) ON DELETE CASCADE,
  national_id text NOT NULL DEFAULT '',
  passport_number text NOT NULL DEFAULT '',
  tax_pin text NOT NULL DEFAULT '',
  social_security_number text NOT NULL DEFAULT '',
  health_insurance_number text NOT NULL DEFAULT '',
  bank_name text NOT NULL DEFAULT '',
  bank_account_reference text NOT NULL DEFAULT '',
  mobile_money_reference text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.employee_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  contact_name text NOT NULL,
  relationship text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  is_next_of_kin boolean NOT NULL DEFAULT false,
  address text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.employee_branch_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, branch_id, effective_from)
);

CREATE TABLE public.employment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  change_type text NOT NULL,
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  reason text NOT NULL DEFAULT '',
  document_url text,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employment_history_emp_idx ON public.employment_history (employee_id, effective_date DESC);

CREATE TABLE public.employee_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'skill',
  name text NOT NULL,
  detail text NOT NULL DEFAULT '',
  proficiency text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.employee_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  certificate_name text NOT NULL,
  issuing_body text NOT NULL DEFAULT '',
  issue_date date,
  expiry_date date,
  verification_status text NOT NULL DEFAULT 'unverified',
  attachment_path text,
  required_for_role text NOT NULL DEFAULT '',
  renewal_reminder_days integer NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_certifications_expiry_idx ON public.employee_certifications (organization_id, expiry_date);

CREATE TABLE public.employee_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  category text NOT NULL,
  title text NOT NULL,
  storage_path text NOT NULL,
  issue_date date,
  expiry_date date,
  confidentiality text NOT NULL DEFAULT 'employee_hr',
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_documents_emp_idx ON public.employee_documents (employee_id, category);

CREATE TABLE public.employee_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  item_name text NOT NULL,
  item_kind text NOT NULL DEFAULT 'uniform',
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  issue_condition text NOT NULL DEFAULT 'good',
  issued_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  return_required boolean NOT NULL DEFAULT true,
  expected_return_date date,
  returned_date date,
  return_condition text,
  status text NOT NULL DEFAULT 'issued',
  charge_reference text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- RECRUITMENT ----------------------------------------------
CREATE TABLE public.vacancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  vacancy_number text NOT NULL,
  job_title text NOT NULL,
  positions integer NOT NULL DEFAULT 1,
  employment_type text NOT NULL DEFAULT 'permanent',
  reporting_manager_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  hiring_manager_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  job_description text NOT NULL DEFAULT '',
  qualifications text NOT NULL DEFAULT '',
  skills text NOT NULL DEFAULT '',
  experience text NOT NULL DEFAULT '',
  salary_min numeric(14,2),
  salary_max numeric(14,2),
  reason text NOT NULL DEFAULT '',
  target_start_date date,
  closing_date date,
  status text NOT NULL DEFAULT 'draft',
  publishing_status text NOT NULL DEFAULT 'unpublished',
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, vacancy_number)
);

CREATE TABLE public.candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vacancy_id uuid REFERENCES public.vacancies(id) ON DELETE SET NULL,
  candidate_number text NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'direct',
  cv_path text,
  cover_letter text NOT NULL DEFAULT '',
  qualifications text NOT NULL DEFAULT '',
  experience text NOT NULL DEFAULT '',
  screening_notes text NOT NULL DEFAULT '',
  interview_score numeric(6,2),
  status text NOT NULL DEFAULT 'applied',
  consent_given boolean NOT NULL DEFAULT false,
  retain_until date,
  converted_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, candidate_number)
);
CREATE UNIQUE INDEX candidates_conversion_uniq ON public.candidates (converted_employee_id) WHERE converted_employee_id IS NOT NULL;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_candidate_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX employees_candidate_uniq ON public.employees (candidate_id) WHERE candidate_id IS NOT NULL;

CREATE TABLE public.interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  vacancy_id uuid REFERENCES public.vacancies(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45,
  interview_type text NOT NULL DEFAULT 'in_person',
  location text NOT NULL DEFAULT '',
  panel_profile_ids uuid[] NOT NULL DEFAULT '{}',
  evaluation_template jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'scheduled',
  recommendation text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.interview_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL REFERENCES public.interviews(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_score numeric(6,2),
  recommendation text NOT NULL DEFAULT '',
  comments text NOT NULL DEFAULT '',
  conflict_declared boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, evaluator_id)
);

CREATE TABLE public.employment_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  vacancy_id uuid REFERENCES public.vacancies(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  job_title text NOT NULL,
  employment_type text NOT NULL DEFAULT 'permanent',
  proposed_start_date date,
  probation_months integer NOT NULL DEFAULT 3,
  compensation_summary text NOT NULL DEFAULT '',
  gross_salary numeric(14,2),
  allowances jsonb NOT NULL DEFAULT '[]'::jsonb,
  conditions text NOT NULL DEFAULT '',
  expiry_date date,
  version integer NOT NULL DEFAULT 1,
  approval_status text NOT NULL DEFAULT 'draft',
  acceptance_status text NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- ONBOARDING -----------------------------------------------
CREATE TABLE public.onboarding_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  employment_type text NOT NULL DEFAULT 'any',
  role_hint text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.onboarding_template_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.onboarding_templates(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  responsible_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  offset_days integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  evidence_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.onboarding_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  template_id uuid REFERENCES public.onboarding_templates(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  title text NOT NULL,
  responsible_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  responsible_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'pending',
  evidence_url text,
  blocker text NOT NULL DEFAULT '',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_assignments_emp_idx ON public.onboarding_assignments (employee_id, status);

-- ---------- SHIFTS & ROSTERS -----------------------------------------
CREATE TABLE public.shift_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes integer NOT NULL DEFAULT 30,
  grace_minutes integer NOT NULL DEFAULT 10,
  overnight boolean NOT NULL DEFAULT false,
  required_skills text NOT NULL DEFAULT '',
  min_staff integer NOT NULL DEFAULT 1,
  max_staff integer,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.employees
  ADD CONSTRAINT employees_default_shift_fkey FOREIGN KEY (default_shift_template_id)
  REFERENCES public.shift_templates(id) ON DELETE SET NULL;

CREATE TABLE public.rosters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  published_at timestamptz,
  published_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE public.roster_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  roster_id uuid NOT NULL REFERENCES public.rosters(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  shift_template_id uuid REFERENCES public.shift_templates(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  shift_date date NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  role_hint text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled',
  is_open_shift boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roster_assignments_emp_date_idx ON public.roster_assignments (employee_id, shift_date);
CREATE UNIQUE INDEX roster_assignments_unique_shift
  ON public.roster_assignments (employee_id, shift_date, shift_template_id)
  WHERE employee_id IS NOT NULL AND shift_template_id IS NOT NULL;

CREATE TABLE public.shift_swap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  assignment_id uuid NOT NULL REFERENCES public.roster_assignments(id) ON DELETE CASCADE,
  requester_employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  target_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  swap_type text NOT NULL DEFAULT 'swap',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending_acceptance',
  accepted_at timestamptz,
  supervisor_note text NOT NULL DEFAULT '',
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  decline_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.overtime_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  overtime_date date NOT NULL,
  shift_template_id uuid REFERENCES public.shift_templates(id) ON DELETE SET NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  hours numeric(8,2) NOT NULL DEFAULT 0,
  overtime_kind text NOT NULL DEFAULT 'planned',
  reason text NOT NULL DEFAULT '',
  related_reference text NOT NULL DEFAULT '',
  rate_category text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'submitted',
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  payroll_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX overtime_requests_emp_idx ON public.overtime_requests (employee_id, overtime_date);

-- ---------- ATTENDANCE ------------------------------------------------
CREATE TABLE public.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  roster_assignment_id uuid REFERENCES public.roster_assignments(id) ON DELETE SET NULL,
  shift_template_id uuid REFERENCES public.shift_templates(id) ON DELETE SET NULL,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  break_minutes integer NOT NULL DEFAULT 0,
  worked_minutes integer NOT NULL DEFAULT 0,
  late_minutes integer NOT NULL DEFAULT 0,
  early_departure_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'web',
  device_reference text NOT NULL DEFAULT '',
  location_evidence jsonb,
  status text NOT NULL DEFAULT 'pending_review',
  exception text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date, shift_template_id)
);
CREATE INDEX attendance_records_org_date_idx ON public.attendance_records (organization_id, work_date DESC);

CREATE TABLE public.attendance_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  attendance_id uuid NOT NULL REFERENCES public.attendance_records(id) ON DELETE CASCADE,
  break_start timestamptz NOT NULL DEFAULT now(),
  break_end timestamptz,
  minutes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.attendance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  attendance_id uuid REFERENCES public.attendance_records(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  correction_type text NOT NULL,
  work_date date NOT NULL,
  requested_clock_in timestamptz,
  requested_clock_out timestamptz,
  previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  evidence_url text,
  status text NOT NULL DEFAULT 'pending_supervisor',
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.attendance_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  device_kind text NOT NULL DEFAULT 'kiosk',
  identifier text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'not_configured',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- LEAVE ------------------------------------------------------
CREATE TABLE public.leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  paid boolean NOT NULL DEFAULT true,
  annual_entitlement_days numeric(8,2) NOT NULL DEFAULT 0,
  accrual_method text NOT NULL DEFAULT 'annual',
  carry_forward boolean NOT NULL DEFAULT false,
  max_carry_forward_days numeric(8,2) NOT NULL DEFAULT 0,
  carry_forward_expiry_months integer NOT NULL DEFAULT 0,
  requires_document boolean NOT NULL DEFAULT false,
  minimum_notice_days integer NOT NULL DEFAULT 0,
  max_consecutive_days numeric(8,2),
  requires_hr_review boolean NOT NULL DEFAULT false,
  eligibility_note text NOT NULL DEFAULT '',
  employment_type_scope text NOT NULL DEFAULT 'any',
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  medical_sensitive boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
  period_year integer NOT NULL,
  entitlement_days numeric(8,2) NOT NULL DEFAULT 0,
  carried_forward_days numeric(8,2) NOT NULL DEFAULT 0,
  taken_days numeric(8,2) NOT NULL DEFAULT 0,
  pending_days numeric(8,2) NOT NULL DEFAULT 0,
  adjustment_days numeric(8,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type_id, period_year)
);

CREATE TABLE public.leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE RESTRICT,
  reference text NOT NULL DEFAULT '',
  start_date date NOT NULL,
  end_date date NOT NULL,
  days numeric(8,2) NOT NULL DEFAULT 0,
  half_day boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  contact_while_away text NOT NULL DEFAULT '',
  handover_notes text NOT NULL DEFAULT '',
  document_path text,
  acting_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  balance_before numeric(8,2),
  balance_after numeric(8,2),
  supervisor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  supervisor_note text NOT NULL DEFAULT '',
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  posted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_emp_idx ON public.leave_requests (employee_id, start_date DESC);

CREATE TABLE public.leave_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
  leave_request_id uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  period_year integer NOT NULL,
  transaction_type text NOT NULL,
  days numeric(8,2) NOT NULL,
  reason text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.return_to_work_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  leave_request_id uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  expected_return_date date,
  actual_return_date date,
  extension_requested boolean NOT NULL DEFAULT false,
  supervisor_confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  hr_confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  fitness_document_path text,
  status text NOT NULL DEFAULT 'pending',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- PERFORMANCE ------------------------------------------------
CREATE TABLE public.performance_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  cycle_type text NOT NULL DEFAULT 'annual',
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  template jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cycle_id uuid REFERENCES public.performance_cycles(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  review_type text NOT NULL DEFAULT 'annual',
  due_date date,
  self_assessment text NOT NULL DEFAULT '',
  supervisor_assessment text NOT NULL DEFAULT '',
  reviewer_comments text NOT NULL DEFAULT '',
  operational_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_rating numeric(5,2),
  development_plan text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  released_to_employee boolean NOT NULL DEFAULT false,
  employee_acknowledged_at timestamptz,
  employee_comment text NOT NULL DEFAULT '',
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX performance_reviews_emp_idx ON public.performance_reviews (employee_id, status);

CREATE TABLE public.performance_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.performance_reviews(id) ON DELETE CASCADE,
  kpi_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  weight numeric(6,2) NOT NULL DEFAULT 0,
  target text NOT NULL DEFAULT '',
  actual_result text NOT NULL DEFAULT '',
  score numeric(6,2),
  data_source text NOT NULL DEFAULT 'manual',
  adjustment_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.hr_kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  role_hint text NOT NULL DEFAULT '',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  measurement_method text NOT NULL DEFAULT '',
  target text NOT NULL DEFAULT '',
  weight numeric(6,2) NOT NULL DEFAULT 0,
  data_source text NOT NULL DEFAULT 'manual',
  review_period text NOT NULL DEFAULT 'quarterly',
  owner_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.performance_objectives
  ADD CONSTRAINT performance_objectives_kpi_fkey FOREIGN KEY (kpi_id) REFERENCES public.hr_kpis(id) ON DELETE SET NULL;

CREATE TABLE public.disciplinary_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  case_number text NOT NULL,
  case_type text NOT NULL DEFAULT 'incident',
  incident_date date,
  summary text NOT NULL,
  investigation_notes text NOT NULL DEFAULT '',
  meeting_at timestamptz,
  employee_response text NOT NULL DEFAULT '',
  witness_information text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text NOT NULL DEFAULT '',
  action_taken text NOT NULL DEFAULT '',
  appeal_notes text NOT NULL DEFAULT '',
  resolution text NOT NULL DEFAULT '',
  follow_up_date date,
  status text NOT NULL DEFAULT 'reported',
  opened_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, case_number)
);

CREATE TABLE public.grievance_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  raised_by_employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  case_number text NOT NULL,
  subject text NOT NULL,
  details text NOT NULL DEFAULT '',
  confidential boolean NOT NULL DEFAULT true,
  investigation_notes text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'reported',
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, case_number)
);

-- ---------- TRAINING ----------------------------------------------------
CREATE TABLE public.training_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  training_type text NOT NULL DEFAULT 'orientation',
  description text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  mandatory boolean NOT NULL DEFAULT false,
  validity_months integer NOT NULL DEFAULT 0,
  cost numeric(14,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  session_date date NOT NULL,
  session_time time,
  location text NOT NULL DEFAULT '',
  trainer text NOT NULL DEFAULT '',
  capacity integer NOT NULL DEFAULT 20,
  cost numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'scheduled',
  feedback_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.training_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  attendance_status text NOT NULL DEFAULT 'assigned',
  completion_status text NOT NULL DEFAULT 'pending',
  score numeric(6,2),
  certificate_path text,
  certificate_expiry date,
  feedback text NOT NULL DEFAULT '',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, employee_id)
);

CREATE TABLE public.certification_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  department_id uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  role_hint text NOT NULL DEFAULT '',
  certificate_name text NOT NULL,
  course_id uuid REFERENCES public.training_courses(id) ON DELETE SET NULL,
  renewal_months integer NOT NULL DEFAULT 12,
  reminder_days integer NOT NULL DEFAULT 30,
  mandatory boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- PAYROLL PREPARATION -----------------------------------------
CREATE TABLE public.payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  locked_at timestamptz,
  locked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  hr_reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  finance_reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE public.payroll_input_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  cost_centre text NOT NULL DEFAULT '',
  scheduled_days numeric(8,2) NOT NULL DEFAULT 0,
  worked_days numeric(8,2) NOT NULL DEFAULT 0,
  worked_hours numeric(10,2) NOT NULL DEFAULT 0,
  overtime_hours numeric(10,2) NOT NULL DEFAULT 0,
  paid_leave_days numeric(8,2) NOT NULL DEFAULT 0,
  unpaid_leave_days numeric(8,2) NOT NULL DEFAULT 0,
  absence_days numeric(8,2) NOT NULL DEFAULT 0,
  late_minutes integer NOT NULL DEFAULT 0,
  allowances numeric(14,2) NOT NULL DEFAULT 0,
  deductions numeric(14,2) NOT NULL DEFAULT 0,
  bonuses numeric(14,2) NOT NULL DEFAULT 0,
  commissions numeric(14,2) NOT NULL DEFAULT 0,
  reimbursements numeric(14,2) NOT NULL DEFAULT 0,
  salary_change_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, employee_id)
);

CREATE TABLE public.payroll_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
  export_format text NOT NULL DEFAULT 'csv',
  scope text NOT NULL DEFAULT 'organization',
  row_count integer NOT NULL DEFAULT 0,
  exported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  notes text NOT NULL DEFAULT ''
);

-- ---------- COMMUNICATION & EXIT -----------------------------------------
CREATE TABLE public.staff_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  audience text NOT NULL DEFAULT 'organization',
  subject text NOT NULL,
  message text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  channel text NOT NULL DEFAULT 'in_system',
  publish_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  attachment_path text,
  requires_acknowledgment boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'published',
  delivery_status text NOT NULL DEFAULT 'in_system_only',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.announcement_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL REFERENCES public.staff_announcements(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  read_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, employee_id)
);

CREATE TABLE public.policy_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  policy_name text NOT NULL,
  policy_version text NOT NULL DEFAULT '1',
  document_path text,
  acknowledged_at timestamptz,
  required_by date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.employee_exit_clearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  separation_type text NOT NULL DEFAULT 'resignation',
  notice_date date,
  last_working_day date,
  exit_interview_notes text NOT NULL DEFAULT '',
  assets_cleared boolean NOT NULL DEFAULT false,
  finance_cleared boolean NOT NULL DEFAULT false,
  it_access_revoked boolean NOT NULL DEFAULT false,
  documents_issued boolean NOT NULL DEFAULT false,
  exception_approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_progress',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.hr_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  early_clock_in_minutes integer NOT NULL DEFAULT 30,
  late_threshold_minutes integer NOT NULL DEFAULT 10,
  missed_clock_out_hours integer NOT NULL DEFAULT 12,
  gps_attendance_enabled boolean NOT NULL DEFAULT false,
  gps_consent_notice text NOT NULL DEFAULT '',
  biometric_configured boolean NOT NULL DEFAULT false,
  qr_attendance_enabled boolean NOT NULL DEFAULT false,
  qr_token_ttl_seconds integer NOT NULL DEFAULT 60,
  external_payroll_configured boolean NOT NULL DEFAULT false,
  ai_assistant_enabled boolean NOT NULL DEFAULT true,
  leave_year_start_month integer NOT NULL DEFAULT 1,
  document_retention_months integer NOT NULL DEFAULT 84,
  probation_default_months integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- GRANTS ------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.employees, public.employee_identifiers, public.employee_emergency_contacts,
  public.employee_branch_assignments, public.employment_history, public.employee_skills,
  public.employee_certifications, public.employee_documents, public.employee_assets,
  public.vacancies, public.candidates, public.interviews, public.interview_evaluations,
  public.employment_offers, public.onboarding_templates, public.onboarding_template_tasks,
  public.onboarding_assignments, public.shift_templates, public.rosters, public.roster_assignments,
  public.shift_swap_requests, public.overtime_requests, public.attendance_records,
  public.attendance_breaks, public.attendance_corrections, public.attendance_devices,
  public.leave_types, public.leave_balances, public.leave_requests, public.leave_transactions,
  public.return_to_work_records, public.performance_cycles, public.performance_reviews,
  public.performance_objectives, public.hr_kpis, public.disciplinary_cases, public.grievance_cases,
  public.training_courses, public.training_sessions, public.training_participants,
  public.certification_requirements, public.payroll_periods, public.payroll_input_records,
  public.payroll_exports, public.staff_announcements, public.announcement_recipients,
  public.policy_acknowledgments, public.employee_exit_clearances, public.hr_settings
TO authenticated;

GRANT ALL ON
  public.employees, public.employee_identifiers, public.employee_emergency_contacts,
  public.employee_branch_assignments, public.employment_history, public.employee_skills,
  public.employee_certifications, public.employee_documents, public.employee_assets,
  public.vacancies, public.candidates, public.interviews, public.interview_evaluations,
  public.employment_offers, public.onboarding_templates, public.onboarding_template_tasks,
  public.onboarding_assignments, public.shift_templates, public.rosters, public.roster_assignments,
  public.shift_swap_requests, public.overtime_requests, public.attendance_records,
  public.attendance_breaks, public.attendance_corrections, public.attendance_devices,
  public.leave_types, public.leave_balances, public.leave_requests, public.leave_transactions,
  public.return_to_work_records, public.performance_cycles, public.performance_reviews,
  public.performance_objectives, public.hr_kpis, public.disciplinary_cases, public.grievance_cases,
  public.training_courses, public.training_sessions, public.training_participants,
  public.certification_requirements, public.payroll_periods, public.payroll_input_records,
  public.payroll_exports, public.staff_announcements, public.announcement_recipients,
  public.policy_acknowledgments, public.employee_exit_clearances, public.hr_settings
TO service_role;

-- ---------- ENABLE RLS + updated_at triggers -----------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employees','employee_identifiers','employee_emergency_contacts','employee_branch_assignments',
    'employment_history','employee_skills','employee_certifications','employee_documents',
    'employee_assets','vacancies','candidates','interviews','interview_evaluations',
    'employment_offers','onboarding_templates','onboarding_template_tasks','onboarding_assignments',
    'shift_templates','rosters','roster_assignments','shift_swap_requests','overtime_requests',
    'attendance_records','attendance_breaks','attendance_corrections','attendance_devices',
    'leave_types','leave_balances','leave_requests','leave_transactions','return_to_work_records',
    'performance_cycles','performance_reviews','performance_objectives','hr_kpis',
    'disciplinary_cases','grievance_cases','training_courses','training_sessions',
    'training_participants','certification_requirements','payroll_periods','payroll_input_records',
    'payroll_exports','staff_announcements','announcement_recipients','policy_acknowledgments',
    'employee_exit_clearances','hr_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name=t AND column_name='updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t||'_touch', t);
    END IF;
  END LOOP;
END $$;

-- ---------- RLS POLICIES --------------------------------------------------
-- Employees: self, team scope, or HR permission.
CREATE POLICY "employees read" ON public.employees FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  profile_id = auth.uid()
  OR public.has_permission('hr-employees','directory.view')
  OR public.has_permission('hr-employees','profile.view')
  OR reporting_manager_id = public.hr_my_employee_id()
  OR (department_id IS NOT NULL AND department_id = public.hr_my_department_id())
));
CREATE POLICY "employees write" ON public.employees FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','create'));
CREATE POLICY "employees update" ON public.employees FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'));

-- Statutory identifiers: restricted permission only.
CREATE POLICY "employee identifiers read" ON public.employee_identifiers FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-employees','statutory.view') OR public.hr_is_self(employee_id)
));
CREATE POLICY "employee identifiers write" ON public.employee_identifiers FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','statutory.view'));
CREATE POLICY "employee identifiers update" ON public.employee_identifiers FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','statutory.view'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','statutory.view'));

-- Generic HR-employee-scoped child tables (self OR profile.view permission).
DO $$
DECLARE t text; perm text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee_emergency_contacts','employee_branch_assignments','employment_history',
    'employee_skills','employee_certifications','employee_assets','onboarding_assignments',
    'policy_acknowledgments'
  ] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id() AND (
        public.hr_is_self(employee_id)
        OR public.has_permission('hr-employees','profile.view')
        OR public.hr_is_team_member(employee_id)
      ));
      CREATE POLICY "%1$s write" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'));
      CREATE POLICY "%1$s update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'))
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'));
      CREATE POLICY "%1$s delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','edit'));
    $f$, t);
  END LOOP;
END $$;

-- Employee documents: confidentiality aware.
CREATE POLICY "employee documents read" ON public.employee_documents FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-employees','documents.manage')
  OR (public.hr_is_self(employee_id) AND confidentiality IN ('employee_hr','employee_self_service'))
  OR (public.hr_is_team_member(employee_id) AND confidentiality = 'manager_hr')
  OR (public.has_permission('hr-payroll','inputs.view') AND confidentiality = 'payroll_hr')
));
CREATE POLICY "employee documents write" ON public.employee_documents FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','documents.manage'));
CREATE POLICY "employee documents update" ON public.employee_documents FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','documents.manage'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','documents.manage'));

-- Recruitment (candidate privacy).
CREATE POLICY "vacancies read" ON public.vacancies FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','vacancies.view'));
CREATE POLICY "vacancies write" ON public.vacancies FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','vacancy.create'));
CREATE POLICY "vacancies update" ON public.vacancies FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (public.has_permission('hr-recruitment','vacancy.create') OR public.has_permission('hr-recruitment','vacancy.approve')))
WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('hr-recruitment','vacancy.create') OR public.has_permission('hr-recruitment','vacancy.approve')));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['candidates','employment_offers'] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','candidates.view'));
      CREATE POLICY "%1$s write" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','candidates.manage'));
      CREATE POLICY "%1$s update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','candidates.manage'))
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','candidates.manage'));
    $f$, t);
  END LOOP;
END $$;

CREATE POLICY "interviews read" ON public.interviews FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-recruitment','candidates.view') OR auth.uid() = ANY (panel_profile_ids)
));
CREATE POLICY "interviews write" ON public.interviews FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','interview.schedule'));
CREATE POLICY "interviews update" ON public.interviews FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','interview.schedule'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-recruitment','interview.schedule'));

CREATE POLICY "interview evaluations read" ON public.interview_evaluations FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  evaluator_id = auth.uid() OR public.has_permission('hr-recruitment','hire.approve')
));
CREATE POLICY "interview evaluations write" ON public.interview_evaluations FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND evaluator_id = auth.uid()
  AND public.has_permission('hr-recruitment','candidate.evaluate'));
CREATE POLICY "interview evaluations update" ON public.interview_evaluations FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND evaluator_id = auth.uid())
WITH CHECK (organization_id = public.current_org_id() AND evaluator_id = auth.uid());

-- Onboarding templates + tasks (HR managed, readable by HR).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['onboarding_templates','onboarding_template_tasks'] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','directory.view'));
      CREATE POLICY "%1$s write" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','create'));
      CREATE POLICY "%1$s update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','create'))
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','create'));
      CREATE POLICY "%1$s delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','create'));
    $f$, t);
  END LOOP;
END $$;

-- Scheduling: shift templates + rosters visible to schedulers; assignments visible to self.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_templates','rosters','attendance_devices'] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id());
      CREATE POLICY "%1$s write" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'));
      CREATE POLICY "%1$s update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND (public.has_permission('hr-scheduling','roster.create') OR public.has_permission('hr-scheduling','roster.publish')))
      WITH CHECK (organization_id = public.current_org_id() AND (public.has_permission('hr-scheduling','roster.create') OR public.has_permission('hr-scheduling','roster.publish')));
      CREATE POLICY "%1$s delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'));
    $f$, t);
  END LOOP;
END $$;

CREATE POLICY "roster assignments read" ON public.roster_assignments FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id)
  OR public.has_permission('hr-scheduling','team.view')
  OR public.has_permission('hr-scheduling','roster.create')
  OR public.hr_is_team_member(employee_id)
));
CREATE POLICY "roster assignments write" ON public.roster_assignments FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'));
CREATE POLICY "roster assignments update" ON public.roster_assignments FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'));
CREATE POLICY "roster assignments delete" ON public.roster_assignments FOR DELETE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-scheduling','roster.create'));

CREATE POLICY "shift swaps read" ON public.shift_swap_requests FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(requester_employee_id) OR public.hr_is_self(target_employee_id)
  OR public.has_permission('hr-scheduling','swap.approve') OR public.has_permission('hr-scheduling','team.view')
));
CREATE POLICY "shift swaps write" ON public.shift_swap_requests FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id()
  AND public.has_permission('hr-scheduling','swap.request')
  AND (public.hr_is_self(requester_employee_id) OR public.has_permission('hr-scheduling','roster.create')));
CREATE POLICY "shift swaps update" ON public.shift_swap_requests FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(target_employee_id) OR public.hr_is_self(requester_employee_id)
  OR public.has_permission('hr-scheduling','swap.approve')))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "overtime read" ON public.overtime_requests FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.hr_is_team_member(employee_id)
  OR public.has_permission('hr-scheduling','overtime.approve')
  OR public.has_permission('hr-payroll','inputs.view')
));
CREATE POLICY "overtime write" ON public.overtime_requests FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-scheduling','roster.create')));
-- Managers approve others' overtime; employees may only edit their own submitted request.
CREATE POLICY "overtime update" ON public.overtime_requests FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  (public.has_permission('hr-scheduling','overtime.approve') AND NOT public.hr_is_self(employee_id))
  OR (public.hr_is_self(employee_id) AND status = 'submitted')))
WITH CHECK (organization_id = public.current_org_id());

-- Attendance.
CREATE POLICY "attendance read" ON public.attendance_records FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id)
  OR public.has_permission('hr-attendance','all.view')
  OR (public.has_permission('hr-attendance','team.view') AND public.hr_is_team_member(employee_id))
));
CREATE POLICY "attendance write" ON public.attendance_records FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND (
  (public.hr_is_self(employee_id) AND public.has_permission('hr-attendance','self.clock'))
  OR public.has_permission('hr-attendance','correct')));
CREATE POLICY "attendance update" ON public.attendance_records FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  (public.hr_is_self(employee_id) AND status IN ('pending_review','incomplete'))
  OR public.has_permission('hr-attendance','correct')))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "attendance breaks read" ON public.attendance_breaks FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND EXISTS (
  SELECT 1 FROM public.attendance_records a WHERE a.id = attendance_id
    AND (public.hr_is_self(a.employee_id) OR public.has_permission('hr-attendance','team.view')
         OR public.has_permission('hr-attendance','all.view'))));
CREATE POLICY "attendance breaks write" ON public.attendance_breaks FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND EXISTS (
  SELECT 1 FROM public.attendance_records a WHERE a.id = attendance_id AND public.hr_is_self(a.employee_id)));
CREATE POLICY "attendance breaks update" ON public.attendance_breaks FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND EXISTS (
  SELECT 1 FROM public.attendance_records a WHERE a.id = attendance_id
    AND (public.hr_is_self(a.employee_id) OR public.has_permission('hr-attendance','correct'))))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "attendance corrections read" ON public.attendance_corrections FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-attendance','correction.approve')
  OR (public.has_permission('hr-attendance','team.view') AND public.hr_is_team_member(employee_id))));
CREATE POLICY "attendance corrections write" ON public.attendance_corrections FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.hr_is_self(employee_id));
CREATE POLICY "attendance corrections update" ON public.attendance_corrections FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id()
  AND public.has_permission('hr-attendance','correction.approve') AND NOT public.hr_is_self(employee_id))
WITH CHECK (organization_id = public.current_org_id());

-- Leave.
CREATE POLICY "leave types read" ON public.leave_types FOR SELECT TO authenticated
USING (organization_id = public.current_org_id());
CREATE POLICY "leave types write" ON public.leave_types FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','types.manage'));
CREATE POLICY "leave types update" ON public.leave_types FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-leave','types.manage'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','types.manage'));

CREATE POLICY "leave balances read" ON public.leave_balances FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-leave','team.view')
  OR public.has_permission('hr-leave','approve')));
CREATE POLICY "leave balances write" ON public.leave_balances FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','balance.adjust'));
CREATE POLICY "leave balances update" ON public.leave_balances FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-leave','balance.adjust'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','balance.adjust'));

CREATE POLICY "leave requests read" ON public.leave_requests FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-leave','approve')
  OR (public.has_permission('hr-leave','team.view') AND public.hr_is_team_member(employee_id))));
CREATE POLICY "leave requests write" ON public.leave_requests FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.hr_is_self(employee_id)
  AND public.has_permission('hr-leave','apply'));
CREATE POLICY "leave requests update" ON public.leave_requests FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  (public.hr_is_self(employee_id) AND status IN ('draft','submitted'))
  OR (public.has_permission('hr-leave','approve') AND NOT public.hr_is_self(employee_id))))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "leave transactions read" ON public.leave_transactions FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-leave','approve')
  OR public.has_permission('hr-leave','balance.adjust')));
CREATE POLICY "leave transactions write" ON public.leave_transactions FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND (
  public.has_permission('hr-leave','approve') OR public.has_permission('hr-leave','balance.adjust')));

CREATE POLICY "return to work read" ON public.return_to_work_records FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-leave','approve')));
CREATE POLICY "return to work write" ON public.return_to_work_records FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','approve'));
CREATE POLICY "return to work update" ON public.return_to_work_records FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-leave','approve'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-leave','approve'));

-- Performance.
CREATE POLICY "performance cycles read" ON public.performance_cycles FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.conduct'));
CREATE POLICY "performance cycles write" ON public.performance_cycles FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.create'));
CREATE POLICY "performance cycles update" ON public.performance_cycles FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.create'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.create'));

CREATE POLICY "performance reviews read" ON public.performance_reviews FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  (public.hr_is_self(employee_id) AND released_to_employee)
  OR reviewer_id = public.hr_my_employee_id()
  OR public.has_permission('hr-performance','reports.view')
  OR (public.has_permission('hr-performance','review.conduct') AND public.hr_is_team_member(employee_id))));
CREATE POLICY "performance reviews write" ON public.performance_reviews FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.create'));
CREATE POLICY "performance reviews update" ON public.performance_reviews FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  (public.hr_is_self(employee_id) AND released_to_employee)
  OR reviewer_id = public.hr_my_employee_id()
  OR public.has_permission('hr-performance','review.approve')))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "performance objectives read" ON public.performance_objectives FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND EXISTS (
  SELECT 1 FROM public.performance_reviews r WHERE r.id = review_id));
CREATE POLICY "performance objectives write" ON public.performance_objectives FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.conduct'));
CREATE POLICY "performance objectives update" ON public.performance_objectives FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.conduct'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','review.conduct'));

CREATE POLICY "hr kpis read" ON public.hr_kpis FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-performance','kpis.manage')
  OR public.has_permission('hr-performance','review.conduct')));
CREATE POLICY "hr kpis write" ON public.hr_kpis FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','kpis.manage'));
CREATE POLICY "hr kpis update" ON public.hr_kpis FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-performance','kpis.manage'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','kpis.manage'));

-- Disciplinary & grievance: restricted; no delete policy at all.
CREATE POLICY "disciplinary read" ON public.disciplinary_cases FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-performance','disciplinary.manage')
  OR (public.hr_is_self(employee_id) AND status IN ('awaiting_response','resolved','closed'))));
CREATE POLICY "disciplinary write" ON public.disciplinary_cases FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','disciplinary.manage'));
CREATE POLICY "disciplinary update" ON public.disciplinary_cases FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-performance','disciplinary.manage')
  OR (public.hr_is_self(employee_id) AND status = 'awaiting_response')))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "grievance read" ON public.grievance_cases FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-performance','grievances.manage')
  OR public.hr_is_self(raised_by_employee_id)));
CREATE POLICY "grievance write" ON public.grievance_cases FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND (
  public.hr_is_self(raised_by_employee_id) OR public.has_permission('hr-performance','grievances.manage')));
CREATE POLICY "grievance update" ON public.grievance_cases FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-performance','grievances.manage'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-performance','grievances.manage'));

-- Training.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_courses','training_sessions','certification_requirements'] LOOP
    EXECUTE format($f$
      CREATE POLICY "%1$s read" ON public.%1$I FOR SELECT TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-training','view'));
      CREATE POLICY "%1$s write" ON public.%1$I FOR INSERT TO authenticated
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-training','manage'));
      CREATE POLICY "%1$s update" ON public.%1$I FOR UPDATE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-training','manage'))
      WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-training','manage'));
      CREATE POLICY "%1$s delete" ON public.%1$I FOR DELETE TO authenticated
      USING (organization_id = public.current_org_id() AND public.has_permission('hr-training','manage'));
    $f$, t);
  END LOOP;
END $$;

CREATE POLICY "training participants read" ON public.training_participants FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-training','view')));
CREATE POLICY "training participants write" ON public.training_participants FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-training','assign'));
CREATE POLICY "training participants update" ON public.training_participants FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-training','completion.record') OR public.hr_is_self(employee_id)))
WITH CHECK (organization_id = public.current_org_id());

-- Payroll preparation.
CREATE POLICY "payroll periods read" ON public.payroll_periods FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.view'));
CREATE POLICY "payroll periods write" ON public.payroll_periods FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.edit'));
CREATE POLICY "payroll periods update" ON public.payroll_periods FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-payroll','inputs.edit') OR public.has_permission('hr-payroll','period.lock')))
WITH CHECK (organization_id = public.current_org_id());

CREATE POLICY "payroll inputs read" ON public.payroll_input_records FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.view'));
CREATE POLICY "payroll inputs write" ON public.payroll_input_records FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.edit'));
CREATE POLICY "payroll inputs update" ON public.payroll_input_records FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.edit'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.edit'));

CREATE POLICY "payroll exports read" ON public.payroll_exports FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','inputs.view'));
CREATE POLICY "payroll exports write" ON public.payroll_exports FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-payroll','export'));

-- Announcements.
CREATE POLICY "announcements read" ON public.staff_announcements FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.has_permission('hr-announcements','manage')
  OR (status = 'published' AND (
      audience = 'organization'
      OR (audience = 'branch' AND branch_id IS NOT DISTINCT FROM (SELECT p.branch_id FROM public.profiles p WHERE p.id = auth.uid()))
      OR (audience = 'department' AND department_id IS NOT DISTINCT FROM public.hr_my_department_id())))));
CREATE POLICY "announcements write" ON public.staff_announcements FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-announcements','manage'));
CREATE POLICY "announcements update" ON public.staff_announcements FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-announcements','manage'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-announcements','manage'));

CREATE POLICY "announcement recipients read" ON public.announcement_recipients FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-announcements','manage')));
CREATE POLICY "announcement recipients write" ON public.announcement_recipients FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-announcements','manage'));
CREATE POLICY "announcement recipients update" ON public.announcement_recipients FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-announcements','manage')))
WITH CHECK (organization_id = public.current_org_id());

-- Exit clearance.
CREATE POLICY "exit clearance read" ON public.employee_exit_clearances FOR SELECT TO authenticated
USING (organization_id = public.current_org_id() AND (
  public.hr_is_self(employee_id) OR public.has_permission('hr-employees','terminate')
  OR public.has_permission('hr-employees','profile.view')));
CREATE POLICY "exit clearance write" ON public.employee_exit_clearances FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','terminate'));
CREATE POLICY "exit clearance update" ON public.employee_exit_clearances FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-employees','terminate'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-employees','terminate'));

-- HR settings.
CREATE POLICY "hr settings read" ON public.hr_settings FOR SELECT TO authenticated
USING (organization_id = public.current_org_id());
CREATE POLICY "hr settings write" ON public.hr_settings FOR INSERT TO authenticated
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-attendance','configure'));
CREATE POLICY "hr settings update" ON public.hr_settings FOR UPDATE TO authenticated
USING (organization_id = public.current_org_id() AND public.has_permission('hr-attendance','configure'))
WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('hr-attendance','configure'));

-- ---------- LOCK DOWN HELPER FUNCTION EXECUTION ---------------------------
REVOKE EXECUTE ON FUNCTION public.hr_my_employee_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hr_my_department_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hr_is_self(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hr_is_team_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_my_employee_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_my_department_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_is_self(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_is_team_member(uuid) TO authenticated;