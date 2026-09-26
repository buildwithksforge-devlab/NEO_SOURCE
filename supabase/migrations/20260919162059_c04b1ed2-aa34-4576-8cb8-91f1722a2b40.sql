create table if not exists public.tenant_column_classification (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  column_name text not null default 'organization_id',
  classification text not null check (classification in ('platform_global','tenant_owned','tenant_owned_deferred','view_derived')),
  rationale text not null,
  enforced boolean not null default false,
  nulls_at_classification integer,
  classified_at timestamptz not null default now(),
  unique (table_name, column_name)
);

grant select on public.tenant_column_classification to authenticated;
grant all on public.tenant_column_classification to service_role;
alter table public.tenant_column_classification enable row level security;

create policy "Workspace admins read the tenant column register"
  on public.tenant_column_classification for select to authenticated
  using (coalesce(public.is_org_admin(), false));

insert into public.tenant_column_classification (table_name, classification, rationale, enforced, nulls_at_classification) values
  ('notification_templates','platform_global','System-supplied default templates that every workspace inherits.',false,17),
  ('uom_units','platform_global','System units of measure shared by all workspaces.',false,17),
  ('readiness_gates','platform_global','Platform-level gates alongside workspace-specific ones.',false,20),
  ('integrity_repair_jobs','platform_global','Platform maintenance jobs that may span workspaces.',false,2),
  ('user_access_snapshots','platform_global','Platform access evidence, including cross-workspace baselines.',false,2),
  ('workspace_provisioning_attempts','platform_global','Recorded before a workspace exists, so it cannot reference one.',false,9),
  ('profiles','tenant_owned_deferred','A person is workspace-owned, but the workspace is assigned during sign-up completion.',false,0),
  ('provisioning_runs','tenant_owned_deferred','Runs start before the workspace record is created.',false,0),
  ('mpesa_callback_events','tenant_owned_deferred','Arrives from the payment provider before it is matched to a workspace.',false,0),
  ('provider_webhook_events','tenant_owned_deferred','Arrives from an external provider before it is matched to a workspace.',false,0),
  ('integration_webhook_receipts','tenant_owned_deferred','Receipt recorded on arrival, matched to a workspace afterwards.',false,0),
  ('neo_pending_role_decisions','view_derived','A view over workspace-owned tables; the constraint belongs to the underlying tables.',false,0),
  ('role_permissions','view_derived','Resolved permission view; the constraint belongs to role_permissions_base.',false,0),
  ('role_permissions_resolved','view_derived','Resolved permission view; the constraint belongs to role_permissions_base.',false,0),
  ('defects','tenant_owned','Every reported problem belongs to the workspace that reported it.',true,0),
  ('feature_flag_overrides','tenant_owned','An override applies to one workspace.',true,0),
  ('knowledge_articles','tenant_owned','Articles are workspace content.',true,0),
  ('security_findings_register','tenant_owned','Findings are raised against one workspace.',true,0),
  ('service_incidents','tenant_owned','Incidents are recorded for one workspace.',true,0),
  ('test_suites','tenant_owned','Test definitions belong to the workspace that owns them.',true,0),
  ('test_cases','tenant_owned','Test definitions belong to the workspace that owns them.',true,0),
  ('test_runs','tenant_owned','Runs belong to the workspace they ran against.',true,0),
  ('test_case_results','tenant_owned','Results belong to the workspace they ran against.',true,0),
  ('backup_records','tenant_owned','A recovery record covers one workspace.',true,0),
  ('role_grant_migration_log','tenant_owned','Every grant change happened inside one workspace.',true,0),
  ('role_grant_migration_log_archive','tenant_owned','Archived grant history keeps its workspace.',true,0)
on conflict (table_name, column_name) do nothing;

alter table public.defects alter column organization_id set not null;
alter table public.feature_flag_overrides alter column organization_id set not null;
alter table public.knowledge_articles alter column organization_id set not null;
alter table public.security_findings_register alter column organization_id set not null;
alter table public.service_incidents alter column organization_id set not null;
alter table public.test_suites alter column organization_id set not null;
alter table public.test_cases alter column organization_id set not null;
alter table public.test_runs alter column organization_id set not null;
alter table public.test_case_results alter column organization_id set not null;
alter table public.backup_records alter column organization_id set not null;
alter table public.role_grant_migration_log alter column organization_id set not null;
alter table public.role_grant_migration_log_archive alter column organization_id set not null;