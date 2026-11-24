BEGIN READ ONLY;
SET LOCAL search_path=public;
WITH expected(signature,definition_md5) AS (VALUES ('ops_room_state(uuid)','5fdd347962dfacb2fc93ebaedf42a348'),
('ops_room_availability(uuid,date,date)','0613e5026b13e25a75960c240fce7293'),
('pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)','9e36e6b7f47c1f87cda18d9724896f56')), code AS (
 SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=definition_md5,false) AS matches FROM expected
)
SELECT jsonb_build_object('diagnostic_version','room-readiness-code-postcheck-v1','read_only',current_setting('transaction_read_only'),
 'definitions_match',(SELECT bool_and(matches) FROM code),'code',(SELECT jsonb_agg(to_jsonb(code)) FROM code),
 'scope','Code definitions only; no physical room release, stay checkout, task completion or full department acceptance is certified.') AS diagnostic;
COMMIT;
