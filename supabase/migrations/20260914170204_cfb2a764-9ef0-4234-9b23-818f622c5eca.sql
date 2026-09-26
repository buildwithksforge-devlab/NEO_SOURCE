insert into public.permissions (module, feature, action, label) values
  ('restaurant','complimentary','view','View Complimentary Register'),
  ('restaurant','complimentary','create','Record Complimentary Entries'),
  ('restaurant','complimentary','edit','Update Complimentary Entries'),
  ('restaurant','complimentary','export','Export Complimentary Register'),
  ('procurement','tasks','view','View Procurement Tasks'),
  ('procurement','tasks','create','Create Procurement Tasks'),
  ('procurement','tasks','edit','Update Procurement Tasks'),
  ('procurement','supplies','view','View Procurement Supply Needs'),
  ('procurement','supplies','create','Raise Procurement Supply Needs'),
  ('procurement','supplies','edit','Update Procurement Supply Needs')
on conflict (module, feature, action) do nothing;

insert into public.role_feature_templates (role_key, module, feature, action) values
  ('owner','restaurant','complimentary','view'),
  ('owner','restaurant','complimentary','create'),
  ('owner','restaurant','complimentary','edit'),
  ('owner','restaurant','complimentary','export'),
  ('it-system-administrator','restaurant','complimentary','view'),
  ('operations-manager','restaurant','complimentary','view'),
  ('operations-manager','restaurant','complimentary','create'),
  ('operations-manager','restaurant','complimentary','edit'),
  ('operations-manager','restaurant','complimentary','export'),
  ('restaurant-manager','restaurant','complimentary','view'),
  ('restaurant-manager','restaurant','complimentary','create'),
  ('restaurant-manager','restaurant','complimentary','edit'),
  ('food-and-beverage-manager','restaurant','complimentary','view'),
  ('food-and-beverage-manager','restaurant','complimentary','create'),
  ('food-and-beverage-manager','restaurant','complimentary','edit'),
  ('food-and-beverage-manager','restaurant','complimentary','export'),
  ('owner','procurement','tasks','view'),
  ('owner','procurement','tasks','create'),
  ('owner','procurement','tasks','edit'),
  ('owner','procurement','supplies','view'),
  ('owner','procurement','supplies','create'),
  ('owner','procurement','supplies','edit'),
  ('it-system-administrator','procurement','tasks','view'),
  ('it-system-administrator','procurement','supplies','view'),
  ('procurement-manager','procurement','tasks','view'),
  ('procurement-manager','procurement','tasks','create'),
  ('procurement-manager','procurement','tasks','edit'),
  ('procurement-manager','procurement','supplies','view'),
  ('procurement-manager','procurement','supplies','create'),
  ('procurement-manager','procurement','supplies','edit'),
  ('procurement-officer','procurement','tasks','view'),
  ('procurement-officer','procurement','tasks','create'),
  ('procurement-officer','procurement','tasks','edit'),
  ('procurement-officer','procurement','supplies','view'),
  ('procurement-officer','procurement','supplies','create'),
  ('procurement-officer','procurement','supplies','edit'),
  ('storekeeper','procurement','supplies','view'),
  ('storekeeper','procurement','supplies','create'),
  ('storekeeper','procurement','supplies','edit')
on conflict (role_key, module, feature, action) do nothing;

do $$
declare _org uuid;
begin
  for _org in select id from public.organizations loop
    perform public.neo_apply_feature_templates(_org);
  end loop;
end $$;