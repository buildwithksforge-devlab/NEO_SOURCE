import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const automationOnly = process.argv.includes('--automation-only');
const sources = [...(automationOnly ? [] : ['supabase/migrations/20261119140000_pos_room_transfer_money_integrity.sql']), 'supabase/migrations/20261119160000_automatic_platform_checks.sql'];
const parts = sources.map(path => {
  const source = readFileSync(path, 'utf8');
  if ((source.match(/^BEGIN;\r?$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\r?$/gm) ?? []).length !== 1) throw Error(`Unexpected transaction layout: ${path}`);
  return `-- Source: ${path}\n${source.replace(/^BEGIN;\r?$/m,'').replace(/^COMMIT;\r?$/m,'')}`;
});
const postcheck = `
DO $status$ DECLARE scheduled boolean:=false; BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname=''neo-platform-integrity-checks'' AND active)' INTO scheduled;
 END IF;
 PERFORM set_config('neo.platform_scheduler_installed',scheduled::text,false);
END $status$;
SELECT jsonb_build_object(
 'automatic_check_function',to_regprocedure('public.neo_platform_run_checks(uuid)')::text,
 'anonymous_checks',has_function_privilege('anon','public.neo_platform_run_checks(uuid)','EXECUTE'),
 'staff_checks',has_function_privilege('authenticated','public.neo_platform_run_checks(uuid)','EXECUTE'),
 'background_schedule_installed',current_setting('neo.platform_scheduler_installed')::boolean,
 'simulation_defect_bridge',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.neo_test_results'::regclass AND tgname='neo_simulation_quality_bridge' AND tgenabled IN ('O','A')),
 'room_transfer_hash',(SELECT md5(regexp_replace(regexp_replace(prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) FROM pg_proc WHERE oid='public.pos_post_room_charge(uuid,uuid,text)'::regprocedure),
 'room_transfer_definition',${automationOnly ? "pg_get_functiondef('public.pos_post_room_charge(uuid,uuid,text)'::regprocedure)" : 'NULL'}
) AS platform_rollout_result;
`;
mkdirSync('supabase/repair/2026-11-19',{recursive:true});
writeFileSync(`supabase/repair/2026-11-19/${automationOnly ? 'INSTALL-PLATFORM-AUTOMATION-ONLY' : 'INSTALL-PLATFORM-AUTOMATION-AND-ROOM-TRANSFER'}.sql`, `-- Atomic shared rollout. Preserves reviewed source guards and existing grants.\n-- No historical balances, stock, payments or folio charges are changed.\nBEGIN;\n${parts.join('\n')}\nCOMMIT;\n${postcheck}`);
console.log('Prepared guarded shared Platform automation / room-transfer installer.');
