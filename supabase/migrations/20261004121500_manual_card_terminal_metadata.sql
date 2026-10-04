-- Manual physical card terminal capture for hotel POS.
--
-- Only non-sensitive card metadata is accepted:
--   terminal  - e.g. ABSA POS 1
--   network   - Visa / Mastercard / Other
--   last4     - optional final four digits
--
-- Approval/reference continues to use pos_payments.external_reference.
--
-- Never store PAN, CVV, PIN, track data or cryptograms.

CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(
  _order_id uuid,
  _amount numeric,
  _method text,
  _tendered numeric,
  _reference text,
  _shift_id uuid,
  _idempotency_key text,
  _manual_confirm boolean,
  _note text,
  _account uuid,
  _payment_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_payment uuid;
  v_meta jsonb := coalesce(_payment_metadata, '{}'::jsonb);
  v_terminal text;
  v_network text;
  v_last4 text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN
    RAISE EXCEPTION 'Payment metadata must be an object';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(v_meta) AS k(key)
    WHERE k.key NOT IN ('terminal', 'network', 'last4')
  ) THEN
    RAISE EXCEPTION 'Unsupported card metadata field';
  END IF;

  v_terminal := nullif(btrim(v_meta->>'terminal'), '');
  v_network := nullif(btrim(v_meta->>'network'), '');
  v_last4 := nullif(btrim(v_meta->>'last4'), '');

  IF v_terminal IS NOT NULL AND length(v_terminal) > 80 THEN
    RAISE EXCEPTION 'Card terminal name is too long';
  END IF;

  IF v_network IS NOT NULL
     AND lower(v_network) NOT IN ('visa', 'mastercard', 'other') THEN
    RAISE EXCEPTION 'Card network must be Visa, Mastercard or Other';
  END IF;

  IF v_last4 IS NOT NULL AND v_last4 !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Card last four digits must contain exactly four numbers';
  END IF;

  IF lower(coalesce(replace(_method, '-', '_'), '')) <> 'card'
     AND v_meta <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Manual terminal metadata is only valid for Card payments';
  END IF;

  v_result := public.pos_record_payment_attempt(
    _order_id,
    _amount,
    _method,
    _tendered,
    _reference,
    _shift_id,
    _idempotency_key,
    _manual_confirm,
    _note,
    _account
  );

  v_payment := nullif(v_result->>'payment_id', '')::uuid;

  IF v_payment IS NOT NULL
     AND lower(coalesce(replace(_method, '-', '_'), '')) = 'card' THEN
    UPDATE public.pos_payments
       SET provider_payload =
             coalesce(provider_payload, '{}'::jsonb)
             || jsonb_strip_nulls(
                  jsonb_build_object(
                    'captureMode', 'manual-terminal',
                    'terminal', v_terminal,
                    'network',
                      CASE
                        WHEN v_network IS NULL THEN NULL
                        ELSE initcap(lower(v_network))
                      END,
                    'last4', v_last4
                  )
                ),
           updated_at = now()
     WHERE id = v_payment
       AND organization_id = public.current_org_id();
  END IF;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.pos_record_payment_attempt(
  uuid, numeric, text, numeric, text, uuid, text, boolean, text, uuid, jsonb
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.pos_record_payment_attempt(
  uuid, numeric, text, numeric, text, uuid, text, boolean, text, uuid, jsonb
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';