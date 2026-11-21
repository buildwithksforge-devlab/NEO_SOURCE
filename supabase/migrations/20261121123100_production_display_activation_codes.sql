BEGIN;

CREATE TABLE public.neo_production_display_activation (
  code_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.neo_production_display_sessions(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.neo_production_display_activation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_production_display_activation FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.neo_production_display_activation_issue(
  _branch uuid, _stations uuid[], _label text, _read_only boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $issue$
DECLARE paired jsonb; code text; expires timestamptz;
BEGIN
  -- Reuse the existing supervisor, property, station and read-only checks.
  paired:=public.neo_production_display_pair(_branch,_stations,_label,_read_only);
  IF paired->>'ok' IS DISTINCT FROM 'true' OR paired->>'token' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'The station session could not be created';
  END IF;
  DELETE FROM public.neo_production_display_activation WHERE expires_at<=now();
  code:='neods_'||encode(extensions.gen_random_bytes(16),'hex');
  expires:=least(now()+interval '10 minutes',(paired->>'expires_at')::timestamptz);
  INSERT INTO public.neo_production_display_activation(code_hash,session_id,token,expires_at)
    VALUES(encode(extensions.digest(code,'sha256'),'hex'),(paired->>'session_id')::uuid,paired->>'token',expires);
  RETURN jsonb_build_object('ok',true,'code',code,'expires_at',expires);
END;
$issue$;
REVOKE ALL ON FUNCTION public.neo_production_display_activation_issue(uuid,uuid[],text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_production_display_activation_issue(uuid,uuid[],text,boolean) TO authenticated;

CREATE FUNCTION public.neo_production_display_activation_claim(_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $claim$
DECLARE claim record; code text:=lower(btrim(coalesce(_code,'')));
BEGIN
  IF code !~ '^neods_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Invalid display activation code'; END IF;
  DELETE FROM public.neo_production_display_activation a
  USING public.neo_production_display_sessions s
  WHERE a.code_hash=encode(extensions.digest(code,'sha256'),'hex')
    AND a.session_id=s.id AND a.expires_at>now() AND s.expires_at>now() AND s.closed_at IS NULL
  RETURNING a.token,s.id,s.expires_at INTO claim;
  IF NOT FOUND THEN RAISE EXCEPTION 'Display activation code expired, already used or unavailable'; END IF;
  RETURN jsonb_build_object('ok',true,'token',claim.token,'session_id',claim.id,'expires_at',claim.expires_at);
END;
$claim$;
REVOKE ALL ON FUNCTION public.neo_production_display_activation_claim(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_production_display_activation_claim(text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
