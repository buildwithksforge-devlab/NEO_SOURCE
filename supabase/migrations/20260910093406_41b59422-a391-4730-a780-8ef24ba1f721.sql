
CREATE OR REPLACE FUNCTION public.neo_payment_manual_tender(_method text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(coalesce(_method,'')) NOT IN
    ('mpesa','mobile','mobile_money','card-terminal','qr')
$$;

UPDATE public.payment_attempts
   SET manual_tender = public.neo_payment_manual_tender(method), updated_at = now()
 WHERE manual_tender IS DISTINCT FROM public.neo_payment_manual_tender(method);
