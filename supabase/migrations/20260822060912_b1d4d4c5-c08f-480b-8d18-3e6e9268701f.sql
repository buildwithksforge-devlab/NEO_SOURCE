-- 1. Canonical weekday domain: ISO 1..7 only (additive, no data change)
ALTER TABLE public.rate_plans
  DROP CONSTRAINT IF EXISTS rate_plans_days_of_week_iso;
ALTER TABLE public.rate_plans
  ADD CONSTRAINT rate_plans_days_of_week_iso
  CHECK (days_of_week IS NULL OR days_of_week <@ ARRAY[1,2,3,4,5,6,7])
  NOT VALID;
ALTER TABLE public.rate_plans VALIDATE CONSTRAINT rate_plans_days_of_week_iso;

-- 2. Pricing engine compares ISO weekday integers, not lowercase day names
CREATE OR REPLACE FUNCTION public.pms_quote_rate(_rate_plan uuid, _arrival date, _departure date, _adults integer DEFAULT 1, _children integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p public.rate_plans;
  v_nights integer := greatest(0, _departure - _arrival);
  v_day date;
  v_dow integer;
  v_nightly numeric := 0;
  v_extra_adult numeric := 0;
  v_child numeric := 0;
  v_child_rate numeric;
  v_sub numeric := 0;
  v_tax numeric := 0;
  v_svc numeric := 0;
  v_priced integer := 0;
  v_restrictions text[] := array[]::text[];
begin
  select * into p from public.rate_plans where id = _rate_plan and organization_id = current_org_id();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Rate plan not available in this workspace');
  end if;
  if v_nights <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'Departure must be at least one night after arrival');
  end if;
  if p.status is distinct from 'active' then
    v_restrictions := v_restrictions || 'Rate plan is not active';
  end if;
  if p.valid_from is not null and _arrival < p.valid_from then
    v_restrictions := v_restrictions || ('Rate plan starts on ' || p.valid_from::text);
  end if;
  if p.valid_to is not null and (_departure - 1) > p.valid_to then
    v_restrictions := v_restrictions || ('Rate plan ends on ' || p.valid_to::text);
  end if;
  if p.min_stay is not null and v_nights < p.min_stay then
    v_restrictions := v_restrictions || ('Minimum stay is ' || p.min_stay || ' night(s)');
  end if;
  if p.max_stay is not null and p.max_stay > 0 and v_nights > p.max_stay then
    v_restrictions := v_restrictions || ('Maximum stay is ' || p.max_stay || ' night(s)');
  end if;

  v_extra_adult := greatest(0, coalesce(_adults,1) - coalesce(p.included_occupancy,2)) * coalesce(p.extra_adult_charge,0);
  v_child_rate := nullif((p.child_pricing ->> 'per_child'), '')::numeric;
  v_child := coalesce(_children,0) * coalesce(v_child_rate, 0);

  v_day := _arrival;
  while v_day < _departure loop
    v_dow := extract(isodow from v_day)::integer;
    if p.days_of_week is null
       or array_length(p.days_of_week, 1) is null
       or v_dow = any (p.days_of_week) then
      v_sub := v_sub + coalesce(p.base_rate,0) + v_extra_adult + v_child;
      v_priced := v_priced + 1;
    end if;
    v_day := v_day + 1;
  end loop;

  if v_priced < v_nights then
    v_restrictions := v_restrictions || 'Rate plan does not apply to every night of this stay';
  end if;

  v_nightly := case when v_priced > 0 then round(v_sub / v_priced, 2) else 0 end;
  if coalesce(p.tax_treatment,'exclusive') = 'exclusive' then
    v_svc := round(v_sub * coalesce(p.service_charge_rate,0) / 100.0, 2);
    v_tax := round((v_sub + v_svc) * coalesce(p.tax_rate,0) / 100.0, 2);
  end if;

  return jsonb_build_object(
    'ok', true,
    'rate_plan_id', p.id,
    'rate_plan', p.name,
    'meal_plan_id', p.meal_plan_id,
    'room_type_id', p.room_type_id,
    'currency', coalesce(p.currency,'KES'),
    'nights', v_nights,
    'priced_nights', v_priced,
    'nightly_rate', v_nightly,
    'extra_adult_charge', v_extra_adult,
    'child_charge', v_child,
    'subtotal', round(v_sub,2),
    'service_charge', v_svc,
    'tax_amount', v_tax,
    'tax_treatment', coalesce(p.tax_treatment,'exclusive'),
    'total_amount', round(v_sub + v_svc + v_tax, 2),
    'cancellation_policy', p.cancellation_policy,
    'deposit_policy', p.deposit_policy,
    'restrictions', to_jsonb(v_restrictions)
  );
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.pms_quote_rate(uuid, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_quote_rate(uuid, date, date, integer, integer) TO authenticated;