DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_functiondef('public.neo_night_audit_run(uuid,date,text)'::regprocedure) INTO def;
  def := replace(def, 'encode(digest(convert_to(summary::text,''UTF8''),''sha256''),''hex'')',
                      'encode(extensions.digest(convert_to(summary::text,''UTF8''),''sha256''),''hex'')');
  EXECUTE def;

  SELECT pg_get_functiondef('public.pms_record_payment(uuid,numeric,text,text,text,text)'::regprocedure) INTO def;
  def := replace(def, 'encode(digest(', 'encode(extensions.digest(');
  EXECUTE def;
END $$;