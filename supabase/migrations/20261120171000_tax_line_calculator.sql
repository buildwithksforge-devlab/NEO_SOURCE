BEGIN;

-- Internal calculator for a resolved, ordered tax snapshot. Callers supply
-- the rules that apply to the line after resolving company/date/exemptions.
-- The calculator has no access to configuration or transaction records.
CREATE FUNCTION public.neo_tax_calculate_line(
  _unit_price numeric, _quantity numeric, _discount numeric, _rules jsonb
)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog
AS $function$
DECLARE
  rule jsonb;
  component jsonb;
  coefficients jsonb := '[]'::jsonb;
  parts jsonb := '[]'::jsonb;
  codes text[] := '{}';
  code text;
  label text;
  treatment text;
  method text;
  value numeric;
  inclusive boolean;
  compound boolean;
  factor numeric;
  fixed_amount numeric;
  accumulated_factor numeric := 0;
  accumulated_fixed numeric := 0;
  inclusive_factor numeric := 1;
  inclusive_fixed numeric := 0;
  gross numeric;
  exact_net numeric;
  net numeric;
  amount numeric;
  included numeric := 0;
  added numeric := 0;
  residue numeric;
  reduction numeric;
  direction numeric;
  index integer;
BEGIN
  IF _unit_price IS NULL OR _quantity IS NULL OR _discount IS NULL
     OR _unit_price::text IN ('NaN','Infinity','-Infinity')
     OR _quantity::text IN ('NaN','Infinity','-Infinity')
     OR _discount::text IN ('NaN','Infinity','-Infinity')
     OR _unit_price < 0 OR _quantity = 0 OR _discount < 0
     OR jsonb_typeof(_rules) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Tax calculation needs a valid unit price, quantity, discount and rule list'
      USING ERRCODE = '22023';
  END IF;
  direction := sign(_quantity);
  IF _discount > _unit_price * abs(_quantity) THEN
    RAISE EXCEPTION 'Discount cannot exceed the line price' USING ERRCODE = '22023';
  END IF;
  gross := round(_unit_price * abs(_quantity) - _discount, 2);

  FOR rule IN SELECT r FROM jsonb_array_elements(_rules) AS a(r) LOOP
    code := nullif(btrim(rule->>'code'), '');
    label := nullif(btrim(rule->>'name'), '');
    treatment := coalesce(rule->>'treatment', 'standard');
    method := rule->>'method';
    value := (rule->>'value')::numeric;
    inclusive := coalesce((rule->>'inclusive')::boolean, true);
    compound := coalesce((rule->>'compound_on_prior')::boolean, false);
    IF code IS NULL OR label IS NULL OR code = ANY(codes)
       OR treatment NOT IN ('standard','zero_rated','exempt')
       OR (treatment = 'standard' AND (method IS NULL OR method NOT IN ('percentage','fixed')
         OR value IS NULL OR value < 0 OR value::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'Each tax rule needs a unique code, a name and a valid calculation'
        USING ERRCODE = '22023';
    END IF;
    codes := array_append(codes, code);
    IF treatment = 'exempt' THEN CONTINUE; END IF;

    -- Each tax is an affine function of the original net price. A rate is a
    -- fraction, as in Finance tax codes. Fixed rules apply per sold unit.
    factor := 0;
    fixed_amount := 0;
    IF treatment = 'standard' THEN
      IF method = 'fixed' THEN
        fixed_amount := value * abs(_quantity);
      ELSE
        factor := value * (1 + CASE WHEN compound THEN accumulated_factor ELSE 0 END);
        fixed_amount := value * CASE WHEN compound THEN accumulated_fixed ELSE 0 END;
      END IF;
    END IF;
    accumulated_factor := accumulated_factor + factor;
    accumulated_fixed := accumulated_fixed + fixed_amount;
    IF inclusive THEN
      inclusive_factor := inclusive_factor + factor;
      inclusive_fixed := inclusive_fixed + fixed_amount;
    END IF;
    coefficients := coefficients || jsonb_build_object(
      'code',code,'name',label,'treatment',treatment,'method',method,'value',value,
      'inclusive',inclusive,'compound_on_prior',compound,'factor',factor,'fixed_amount',fixed_amount
    );
  END LOOP;

  IF inclusive_fixed > gross THEN
    RAISE EXCEPTION 'Included fixed taxes exceed the sale price' USING ERRCODE = '22023';
  END IF;
  exact_net := (gross - inclusive_fixed) / inclusive_factor;
  FOR component IN SELECT c FROM jsonb_array_elements(coefficients) AS a(c) LOOP
    amount := round((component->>'factor')::numeric * exact_net + (component->>'fixed_amount')::numeric, 2);
    IF (component->>'inclusive')::boolean THEN included := included + amount;
    ELSE added := added + amount;
    END IF;
    parts := parts || ((component - 'factor' - 'fixed_amount') || jsonb_build_object('amount',amount));
  END LOOP;

  -- Assign normal cent residuals to net. If independently rounded taxes
  -- would make net negative, reduce the last included components in rule order.
  residue := greatest(included - gross, 0);
  IF residue > 0 THEN
    FOR index IN REVERSE jsonb_array_length(parts)-1..0 LOOP
      component := parts->index;
      IF (component->>'inclusive')::boolean THEN
        amount := (component->>'amount')::numeric;
        reduction := least(residue, amount);
        parts := jsonb_set(parts, ARRAY[index::text,'amount'], to_jsonb(amount - reduction));
        included := included - reduction;
        residue := residue - reduction;
        EXIT WHEN residue = 0;
      END IF;
    END LOOP;
  END IF;
  net := gross - included;
  IF direction < 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_set(p, '{amount}', to_jsonb(-(p->>'amount')::numeric)) ORDER BY i), '[]'::jsonb)
      INTO parts FROM jsonb_array_elements(parts) WITH ORDINALITY AS a(p,i);
  END IF;
  RETURN jsonb_build_object(
    'selling_amount',gross*direction,'net',net*direction,
    'included_tax',included*direction,'added_tax',added*direction,
    'total',(gross+added)*direction,'taxes',parts
  );
END
$function$;
REVOKE ALL ON FUNCTION public.neo_tax_calculate_line(numeric,numeric,numeric,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_tax_calculate_line(numeric,numeric,numeric,jsonb) TO service_role;
COMMIT;
