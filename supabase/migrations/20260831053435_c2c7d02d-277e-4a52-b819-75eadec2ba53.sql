CREATE OR REPLACE FUNCTION public.neo_finance_post_eligible(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date, _module text DEFAULT NULL::text, _limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE item record; posted int := 0; blocked int := 0; failed int := 0; res jsonb;
        cap int := least(greatest(coalesce(_limit,50), 1), 200);
BEGIN
  IF NOT (public.is_org_admin() OR public.has_permission('finance','edit')
          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  FOR item IN
    SELECT * FROM public.neo_finance_posting_queue(_branch, _from, _to) qq
     WHERE qq.eligible AND (_module IS NULL OR qq.source_module = _module)
     LIMIT cap
  LOOP
    -- Same routing as posting one row by hand: deposits, guest payments and
    -- the procurement families each have their own poster.
    res := public.neo_finance_post_family(item.source_module, item.source_id, true);
    IF coalesce((res->>'ok')::boolean, false) THEN posted := posted + 1;
    ELSIF res->>'reason' = 'failed' THEN failed := failed + 1;
    ELSE blocked := blocked + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('posted', posted, 'blocked', blocked, 'failed', failed,
                            'limit', cap, 'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.neo_finance_post_eligible(uuid, date, date, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_eligible(uuid, date, date, text, integer) TO authenticated;