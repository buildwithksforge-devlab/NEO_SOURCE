-- ============ HR PERMISSION CATALOGUE ============
INSERT INTO public.permissions (module, action, label) VALUES
  ('hr-employees','directory.view','View employee directory'),
  ('hr-employees','profile.view','View full employee records'),
  ('hr-employees','create','Create employee records'),
  ('hr-employees','edit','Edit employee records'),
  ('hr-employees','statutory.view','View statutory & bank identifiers'),
  ('hr-employees','compensation.view','View compensation information'),
  ('hr-employees','documents.manage','Manage employee documents'),
  ('hr-employees','activate','Activate employee records'),
  ('hr-employees','suspend','Suspend employees'),
  ('hr-employees','terminate','Terminate & run exit clearance'),
  ('hr-employees','access.manage','Link or revoke system access'),
  ('hr-recruitment','vacancies.view','View vacancies'),
  ('hr-recruitment','vacancy.create','Raise vacancies'),
  ('hr-recruitment','vacancy.approve','Approve vacancies'),
  ('hr-recruitment','candidates.view','View candidates'),
  ('hr-recruitment','candidates.manage','Manage candidates'),
  ('hr-recruitment','interview.schedule','Schedule interviews'),
  ('hr-recruitment','candidate.evaluate','Submit interview evaluations'),
  ('hr-recruitment','hire.approve','Approve hiring decisions'),
  ('hr-recruitment','candidate.convert','Convert candidate to employee'),
  ('hr-attendance','self.clock','Clock in and out'),
  ('hr-attendance','self.view','View own attendance'),
  ('hr-attendance','team.view','View team attendance'),
  ('hr-attendance','all.view','View all attendance'),
  ('hr-attendance','correct','Correct attendance records'),
  ('hr-attendance','correction.approve','Approve attendance corrections'),
  ('hr-attendance','configure','Configure attendance rules'),
  ('hr-scheduling','self.view','View own schedule'),
  ('hr-scheduling','team.view','View team schedule'),
  ('hr-scheduling','roster.create','Create and edit rosters'),
  ('hr-scheduling','roster.approve','Approve rosters'),
  ('hr-scheduling','roster.publish','Publish rosters'),
  ('hr-scheduling','swap.request','Request shift swaps'),
  ('hr-scheduling','swap.approve','Approve shift swaps'),
  ('hr-scheduling','overtime.approve','Approve overtime'),
  ('hr-leave','self.view','View own leave'),
  ('hr-leave','apply','Apply for leave'),
  ('hr-leave','team.view','View team leave'),
  ('hr-leave','approve','Approve leave'),
  ('hr-leave','types.manage','Manage leave types'),
  ('hr-leave','balance.adjust','Adjust leave balances'),
  ('hr-leave','medical.view','View medical leave documents'),
  ('hr-performance','self.view','View own reviews'),
  ('hr-performance','review.create','Create review cycles'),
  ('hr-performance','review.conduct','Conduct reviews'),
  ('hr-performance','review.approve','Approve reviews'),
  ('hr-performance','kpis.manage','Manage KPIs'),
  ('hr-performance','reports.view','View performance reports'),
  ('hr-performance','disciplinary.manage','Manage disciplinary cases'),
  ('hr-performance','grievances.manage','Manage grievances'),
  ('hr-training','view','View training'),
  ('hr-training','manage','Manage training catalogue'),
  ('hr-training','assign','Assign training'),
  ('hr-training','completion.record','Record training completion'),
  ('hr-training','certifications.manage','Manage certifications'),
  ('hr-payroll','inputs.view','View payroll inputs'),
  ('hr-payroll','inputs.edit','Edit payroll inputs'),
  ('hr-payroll','inputs.approve','Approve payroll inputs'),
  ('hr-payroll','export','Export payroll inputs'),
  ('hr-payroll','labour_cost.view','View labour cost analytics'),
  ('hr-payroll','period.lock','Lock payroll periods'),
  ('hr-reports','view','View HR reports'),
  ('hr-reports','export','Export HR reports'),
  ('hr-announcements','view','View staff announcements'),
  ('hr-announcements','manage','Manage staff announcements')
ON CONFLICT (module, action) DO NOTHING;

-- ============ ROLE GRANTS ============
-- Full HR access for leadership + HR roles.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module LIKE 'hr-%'
WHERE r.name IN ('Owner','System Administrator','General Manager','Human Resources')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Self-service baseline for every role.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON (p.module, p.action) IN (
    ('hr-attendance','self.clock'), ('hr-attendance','self.view'),
    ('hr-scheduling','self.view'), ('hr-scheduling','swap.request'),
    ('hr-leave','self.view'), ('hr-leave','apply'),
    ('hr-performance','self.view'), ('hr-training','view'),
    ('hr-announcements','view')
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Team scope for supervisors and departmental managers.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p
  ON (p.module, p.action) IN (
    ('hr-employees','directory.view'),
    ('hr-attendance','team.view'), ('hr-attendance','correction.approve'),
    ('hr-scheduling','team.view'), ('hr-scheduling','roster.create'),
    ('hr-scheduling','roster.publish'), ('hr-scheduling','swap.approve'),
    ('hr-scheduling','overtime.approve'),
    ('hr-leave','team.view'), ('hr-leave','approve'),
    ('hr-performance','review.conduct'),
    ('hr-training','assign')
  )
WHERE r.name IN (
  'Finance Manager','Front Office Manager','Restaurant Manager','Kitchen Manager',
  'Housekeeping Supervisor','Maintenance Officer','Marketing Manager','Events Manager',
  'Procurement Officer'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============ DEFAULT CONFIGURATION PER ORGANIZATION ============
INSERT INTO public.hr_settings (organization_id)
SELECT o.id FROM public.organizations o
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO public.leave_types
  (organization_id, code, name, paid, annual_entitlement_days, accrual_method, carry_forward,
   max_carry_forward_days, carry_forward_expiry_months, requires_document, minimum_notice_days,
   requires_hr_review, medical_sensitive)
SELECT o.id, t.code, t.name, t.paid, t.days, t.accrual, t.cf, t.cf_max, t.cf_exp, t.doc, t.notice, t.hr, t.med
FROM public.organizations o
CROSS JOIN (VALUES
  ('ANNUAL','Annual Leave',      true,  21::numeric, 'monthly', true,  10::numeric, 6, false, 14, false, false),
  ('SICK','Sick Leave',          true,  14::numeric, 'annual',  false,  0::numeric, 0, true,   0, true,  true),
  ('MATERNITY','Maternity Leave',true,  90::numeric, 'event',   false,  0::numeric, 0, true,  30, true,  true),
  ('PATERNITY','Paternity Leave',true,  14::numeric, 'event',   false,  0::numeric, 0, true,  14, true,  true),
  ('COMPASSION','Compassionate Leave', true, 5::numeric, 'event', false, 0::numeric, 0, false, 0, false, false),
  ('UNPAID','Unpaid Leave',      false,  0::numeric, 'event',   false,  0::numeric, 0, false,  7, true,  false),
  ('STUDY','Study Leave',        true,   5::numeric, 'annual',  false,  0::numeric, 0, true,  30, true,  false)
) AS t(code, name, paid, days, accrual, cf, cf_max, cf_exp, doc, notice, hr, med)
ON CONFLICT (organization_id, code) DO NOTHING;