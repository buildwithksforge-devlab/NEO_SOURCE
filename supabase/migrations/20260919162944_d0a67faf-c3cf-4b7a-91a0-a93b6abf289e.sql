-- Internal-only privileged routines: reached by triggers and other routines,
-- never called directly by a signed-in session.
revoke execute on function public.pos_recalc_order_totals(uuid) from anon, authenticated, public;
revoke execute on function public.neo_pos_apply_settlement_status(uuid, boolean) from anon, authenticated, public;
revoke execute on function public.neo_pos_settlement_evidence(uuid) from anon, authenticated, public;
revoke execute on function public.neo_mpesa_delivery_sync(uuid, boolean) from anon, authenticated, public;
revoke execute on function public.recipe_expand_to_stock(uuid, numeric, uuid, uuid[]) from anon, authenticated, public;
revoke execute on function public.neo_resolve_role_template_key(text, text) from anon, authenticated, public;
revoke execute on function public.neo_role_is_staffed(uuid) from anon, authenticated, public;
revoke execute on function public.neo_reporting_candidate_rows(uuid, uuid, uuid, uuid[]) from anon, authenticated, public;
revoke execute on function public.neo_recommended_reporting_manager(uuid, uuid, uuid, uuid, uuid[]) from anon, authenticated, public;
revoke execute on function public.neo_hr_leave_applies(uuid, uuid, date) from anon, authenticated, public;
revoke execute on function public.neo_hr_leave_gender_allowed(uuid, uuid) from anon, authenticated, public;
revoke execute on function public.neo_admin_recover_workspace(uuid) from anon, authenticated, public;
revoke execute on function public.inventory_consume_order_item(uuid) from anon, authenticated, public;
revoke execute on function public.pos_reconcile_settlement_internal(uuid) from anon, authenticated, public;

create table if not exists public.privileged_function_review (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  identity_arguments text not null default '',
  reachability text not null check (reachability in ('app_callable','policy_referenced','view_referenced','internal_only','public_surface')),
  sensitive boolean not null default false,
  establishes_tenant_context boolean not null default false,
  review_note text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (function_name, identity_arguments)
);

grant select on public.privileged_function_review to authenticated;
grant all on public.privileged_function_review to service_role;

alter table public.privileged_function_review enable row level security;

create policy "Platform administrators read privileged routine review"
  on public.privileged_function_review for select to authenticated
  using (is_org_admin_for(current_org_id()));

create or replace function public.neo_privileged_review_touch()
returns trigger
language plpgsql
set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

create trigger privileged_function_review_touch
  before update on public.privileged_function_review
  for each row execute function public.neo_privileged_review_touch();

-- Live audit: recalculated from the catalogue, never from a stored opinion.
create or replace function public.neo_privileged_function_audit()
returns table (
  function_name text,
  identity_arguments text,
  sensitive boolean,
  establishes_tenant_context boolean,
  has_fixed_search_path boolean,
  anon_executable boolean,
  authenticated_executable boolean,
  reachability text
)
language sql
stable
security definer
set search_path = public
as $$
  with f as (
    select p.oid,
           p.proname::text as nm,
           pg_get_function_identity_arguments(p.oid) as args,
           pg_get_functiondef(p.oid) as def,
           coalesce(p.proconfig::text, '') as cfg,
           p.prorettype = 'pg_catalog.trigger'::regtype as is_trigger,
           has_function_privilege('anon', p.oid, 'execute') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
  )
  select f.nm,
         f.args,
         f.nm ~* 'fin_|payment|mpesa|payroll|hr_|pos_|stock|inventory|import|report|integration|automation|admin|role|permission',
         f.def ~* 'current_org_id|current_organisation_id|organization_id|auth\.uid|has_permission|neo_assert_capability|is_org_admin',
         f.cfg ilike '%search_path%',
         f.anon_exec,
         f.auth_exec,
         case
           when f.is_trigger then 'internal_only'
           when f.anon_exec then 'public_surface'
           when exists (
             select 1 from pg_policy pol
             where pg_get_expr(pol.polqual, pol.polrelid, true) ilike '%' || f.nm || '(%'
                or pg_get_expr(pol.polwithcheck, pol.polrelid, true) ilike '%' || f.nm || '(%'
           ) then 'policy_referenced'
           when exists (
             select 1 from pg_views v
             where v.schemaname = 'public' and v.definition ilike '%' || f.nm || '(%'
           ) then 'view_referenced'
           when f.auth_exec then 'app_callable'
           else 'internal_only'
         end
  from f
  where is_org_admin_for(current_org_id())
  order by f.nm;
$$;

revoke execute on function public.neo_privileged_function_audit() from anon, public;
grant execute on function public.neo_privileged_function_audit() to authenticated;

insert into public.privileged_function_review (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context, review_note)
values
  ('pos_recalc_order_totals','_order uuid','internal_only',true,false,'Recalculates one order total; reached from sales triggers only. Direct call rights withdrawn.'),
  ('neo_pos_apply_settlement_status','_order uuid, _fully boolean','internal_only',true,false,'Settlement status writer; reached from payment routines only.'),
  ('neo_pos_settlement_evidence','_order uuid','internal_only',true,false,'Settlement evidence reader used by reconciliation.'),
  ('neo_mpesa_delivery_sync','_pos_order uuid, _paid boolean','internal_only',true,false,'Mobile-money callback path; reached from the verified callback routine only.'),
  ('recipe_expand_to_stock','_recipe uuid, _batches numeric, _branch uuid, _path uuid[]','internal_only',true,false,'Recipe expansion helper used by consumption posting.'),
  ('neo_resolve_role_template_key','_key text, _name text','internal_only',true,false,'Role template key resolver used during role linking.'),
  ('neo_role_is_staffed','_role uuid','internal_only',true,false,'Role staffing check used by role guards.'),
  ('neo_reporting_candidate_rows','_org uuid, _profile uuid, _branch uuid, _role_ids uuid[]','internal_only',true,false,'Reporting-line candidate helper; takes an explicit workspace argument.'),
  ('neo_recommended_reporting_manager','_user uuid, _branch uuid, _department uuid, _station uuid, _role_ids uuid[]','internal_only',true,false,'Reporting-line suggestion helper.'),
  ('neo_hr_leave_applies','_employee uuid, _leave_type uuid, _on date','internal_only',true,false,'Leave eligibility helper used by the leave enforcement trigger.'),
  ('neo_hr_leave_gender_allowed','_employee uuid, _leave_type uuid','internal_only',true,false,'Leave eligibility helper used by the leave enforcement trigger.'),
  ('neo_admin_recover_workspace','_user uuid','internal_only',true,false,'Workspace recovery helper; restricted to internal recovery routines.'),
  ('inventory_consume_order_item','_order_item uuid','internal_only',true,false,'Wrapper over the workspace-scoped consumption routine.'),
  ('pos_reconcile_settlement_internal','_order_id uuid','internal_only',true,false,'Internal settlement reconciliation used by payment routines.'),
  ('hr_is_self','_employee uuid','policy_referenced',true,false,'Self check evaluated inside access rules; the rule supplies the workspace scope.'),
  ('canonical_permission','_module text, _feature text, _action text','view_referenced',true,false,'Pure permission-name normaliser; touches no tenant data.'),
  ('neo_role_permission_ids','_role_id uuid','view_referenced',true,false,'Permission id resolver used by the resolved permission view.'),
  ('neo_public_menu','_org uuid, _branch uuid, _fulfilment text','public_surface',false,true,'Deliberate signed-out surface: published, available menu items for one workspace only.')
on conflict (function_name, identity_arguments) do update
  set reachability = excluded.reachability,
      sensitive = excluded.sensitive,
      establishes_tenant_context = excluded.establishes_tenant_context,
      review_note = excluded.review_note,
      reviewed_at = now();