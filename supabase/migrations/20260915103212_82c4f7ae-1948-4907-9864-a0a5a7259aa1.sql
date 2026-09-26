DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef('public.neo_night_audit_run(uuid,date,text)'::regprocedure) INTO def;
  def := replace(def, 'snapshot jsonb:=''[]''; summary jsonb; digest text;', 'snapshot jsonb:=''[]''; v_summary jsonb; v_digest text;');
  def := replace(def, '  summary:=jsonb_build_object(''reference'',ref,''operator''', '  v_summary:=jsonb_build_object(''reference'',ref,''operator''');
  def := replace(def, 'digest:=encode(extensions.digest(convert_to(summary::text,''UTF8''),''sha256''),''hex'')',
                      'v_digest:=encode(extensions.digest(convert_to(v_summary::text,''UTF8''),''sha256''),''hex'')');
  def := replace(def, 'exception_snapshot=snapshot,summary=summary,result_digest=digest,signed_at=now()',
                      'exception_snapshot=snapshot,summary=v_summary,result_digest=v_digest,signed_at=now()');
  def := replace(def, 'exception_snapshot=snapshot,result_digest=digest,completed_at=now()',
                      'exception_snapshot=snapshot,result_digest=v_digest,completed_at=now()');
  def := replace(def, '''posting'',posting,''digest'',digest,''error'',err', '''posting'',posting,''digest'',v_digest,''error'',err');
  def := replace(def, '''stage'',CASE WHEN err IS NOT NULL THEN ''failed'' ELSE ''signed'' END,''digest'',digest,''posting'',posting',
                      '''stage'',CASE WHEN err IS NOT NULL THEN ''failed'' ELSE ''signed'' END,''digest'',v_digest,''posting'',posting');
  IF def ~ '\msummary\M[^=]*jsonb;' THEN RAISE EXCEPTION 'rename incomplete'; END IF;
  EXECUTE def;
END $$;