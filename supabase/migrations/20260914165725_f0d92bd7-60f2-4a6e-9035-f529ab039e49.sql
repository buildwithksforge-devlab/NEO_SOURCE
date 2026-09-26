-- 1. Catalogue the feature permissions the Operations screens already demand.
insert into public.permissions (module, feature, action, label) values
  ('housekeeping','inspections','view','View Room Inspections'),
  ('housekeeping','inspections','edit','Record Room Inspections'),
  ('laundry','guest','view','View Guest Laundry'),
  ('laundry','guest','create','Create Guest Laundry Orders'),
  ('laundry','guest','edit','Update Guest Laundry Orders'),
  ('laundry','my-work','view','View Assigned Laundry Work'),
  ('laundry','batches','view','View Laundry Batches'),
  ('laundry','incidents','view','View Laundry Incidents'),
  ('laundry','incidents','create','Report Laundry Incidents'),
  ('laundry','incidents','edit','Update Laundry Incidents'),
  ('laundry','supplies','view','View Laundry Supply Needs'),
  ('laundry','supplies','create','Raise Laundry Supply Needs'),
  ('laundry','supplies','edit','Update Laundry Supply Needs'),
  ('maintenance','my-jobs','view','View My Maintenance Jobs'),
  ('maintenance','my-jobs','edit','Update My Maintenance Jobs'),
  ('maintenance','grounds','view','View Grounds Work'),
  ('maintenance','grounds','create','Create Grounds Tasks'),
  ('maintenance','grounds','edit','Update Grounds Tasks'),
  ('maintenance','landscaping','view','View Landscaping Programme'),
  ('maintenance','landscaping','edit','Manage Landscaping Programme'),
  ('maintenance','my-tasks','view','View My Grounds Tasks'),
  ('maintenance','my-tasks','edit','Update My Grounds Tasks'),
  ('maintenance','supplies','view','View Maintenance Supply Needs'),
  ('maintenance','supplies','create','Raise Maintenance Supply Needs'),
  ('maintenance','supplies','edit','Update Maintenance Supply Needs'),
  ('maintenance','assets','view','View Assets & Equipment'),
  ('events','banqueting','view','View Banqueting Board'),
  ('events','banqueting','edit','Manage Banqueting Board'),
  ('events','my_tasks','view','View My Banqueting Tasks'),
  ('events','my_tasks','edit','Update My Banqueting Tasks')
on conflict (module, feature, action) do nothing;

-- 2. List the new features on the job templates that need them.
insert into public.role_feature_templates (role_key, module, feature, action) values
  ('laundry-attendant','laundry','my-work','view'),
  ('laundry-attendant','laundry','supplies','view'),
  ('laundry-attendant','laundry','supplies','create'),
  ('laundry-attendant','laundry','supplies','edit'),
  ('laundry-supervisor','laundry','guest','view'),
  ('laundry-supervisor','laundry','guest','create'),
  ('laundry-supervisor','laundry','guest','edit'),
  ('laundry-supervisor','laundry','my-work','view'),
  ('laundry-supervisor','laundry','batches','view'),
  ('laundry-supervisor','laundry','incidents','view'),
  ('laundry-supervisor','laundry','incidents','create'),
  ('laundry-supervisor','laundry','incidents','edit'),
  ('laundry-supervisor','laundry','supplies','view'),
  ('laundry-supervisor','laundry','supplies','create'),
  ('laundry-supervisor','laundry','supplies','edit'),
  ('maintenance-officer','maintenance','my-jobs','view'),
  ('maintenance-officer','maintenance','my-jobs','edit'),
  ('maintenance-officer','maintenance','grounds','view'),
  ('maintenance-officer','maintenance','grounds','create'),
  ('maintenance-officer','maintenance','grounds','edit'),
  ('maintenance-officer','maintenance','supplies','view'),
  ('maintenance-officer','maintenance','supplies','create'),
  ('maintenance-officer','maintenance','supplies','edit'),
  ('maintenance-technician','maintenance','my-jobs','view'),
  ('maintenance-technician','maintenance','my-jobs','edit'),
  ('maintenance-technician','maintenance','grounds','view'),
  ('maintenance-technician','maintenance','grounds','create'),
  ('maintenance-technician','maintenance','grounds','edit'),
  ('maintenance-technician','maintenance','supplies','view'),
  ('maintenance-technician','maintenance','supplies','create'),
  ('maintenance-technician','maintenance','supplies','edit'),
  ('grounds-worker','maintenance','my-tasks','view'),
  ('grounds-worker','maintenance','my-tasks','edit'),
  ('grounds-worker','maintenance','supplies','view'),
  ('grounds-worker','maintenance','supplies','create'),
  ('grounds-worker','maintenance','supplies','edit'),
  ('events-coordinator','events','banqueting','view'),
  ('events-coordinator','events','banqueting','edit'),
  ('events-coordinator','events','my_tasks','view'),
  ('events-coordinator','events','my_tasks','edit'),
  ('banqueting-staff','events','banqueting','view'),
  ('banqueting-staff','events','my_tasks','view'),
  ('banqueting-staff','events','my_tasks','edit')
on conflict (role_key, module, feature, action) do nothing;

-- 3. Re-apply the templates for every workspace (additive; nothing is removed).
do $$
declare _org uuid;
begin
  for _org in select id from public.organizations loop
    perform public.neo_apply_feature_templates(_org);
  end loop;
end $$;