SELECT to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') AS save_routine,
       to_regprocedure('public.neo_recipe_activate(uuid,uuid)') AS approve_routine;
SELECT has_function_privilege('authenticated','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE') AS staff_save,
       has_function_privilege('anon','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE') AS anonymous_save;
NOTIFY pgrst, 'reload schema';