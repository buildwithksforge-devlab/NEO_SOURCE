-- Card payments are not bank deposits at the moment of sale.
--
-- destination_account_id remains on the payment so NEØ knows which bank
-- account the acquirer is expected to settle into later. It must not,
-- however, cause the POS sale itself to debit that bank account.
--
-- Sale:
--   Dr Card Clearing
--   Cr Revenue / VAT / Service Charge
--
-- Later acquirer settlement:
--   Dr Bank
--   Dr Merchant Fees (where applicable)
--   Cr Card Clearing

CREATE OR REPLACE FUNCTION public.neo_gl_account_code(
  _org uuid,
  _method text,
  _account uuid DEFAULT NULL::uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_method text := lower(coalesce(replace(_method, '-', '_'), ''));
BEGIN
  IF _org IS NULL THEN
    RETURN NULL;
  END IF;

  -- Card proceeds belong in Card Clearing until the acquirer actually
  -- settles them into the nominated bank account.
  --
  -- Keep _account on the source payment for later settlement/reconciliation,
  -- but deliberately do not use it as the sale-side debit account.
  IF v_method IN ('card', 'card_terminal', 'credit_card', 'debit_card') THEN
    RETURN public.neo_gl_settlement_code_for(_org, _method);
  END IF;

  -- Other recorded tenders retain the existing destination-account behaviour.
  -- For example, a bank transfer already received into a specific bank account
  -- may post directly to that account.
  IF _account IS NOT NULL THEN
    SELECT a.code
      INTO v_code
      FROM public.bank_accounts b
      JOIN public.chart_of_accounts a
        ON a.id = b.gl_account_id
     WHERE b.id = _account
       AND b.organization_id = _org
       AND a.organization_id = _org
       AND coalesce(b.active, true)
       AND a.active
       AND coalesce(a.postable, true)
       AND coalesce(a.is_header, false) = false;

    IF v_code IS NOT NULL THEN
      RETURN v_code;
    END IF;
  END IF;

  RETURN public.neo_gl_settlement_code_for(_org, _method);
END
$function$;

GRANT EXECUTE
  ON FUNCTION public.neo_gl_account_code(uuid, text, uuid)
  TO authenticated, service_role;

-- Keep the compatibility helper on exactly the same settlement rule.
CREATE OR REPLACE FUNCTION public.neo_gl_cash_code(
  _org uuid,
  _method text,
  _account uuid DEFAULT NULL::uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.neo_gl_account_code(_org, _method, _account)
$function$;

GRANT EXECUTE
  ON FUNCTION public.neo_gl_cash_code(uuid, text, uuid)
  TO authenticated, service_role;