REVOKE EXECUTE ON FUNCTION public.pms_record_payment(uuid, numeric, text, text, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_financial_accounts(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_fin_activate_due_periods(uuid, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_inventory_allows_negative(uuid, uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.neo_gl_account_code(uuid, text, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_assert_financial_account(uuid, uuid, uuid) FROM anon, authenticated;

INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
   classification, trusts_client_tenant, search_path_fixed, domain, review_note)
VALUES
  ('neo_gl_account_code', '_org uuid, _method text, _account uuid', 'internal_only', true, false,
   'settlement_resolver', false, true, 'finance',
   'Internal helper used by posting routines only; validates the account against the workspace before use.'),
  ('neo_assert_financial_account', '_org uuid, _branch uuid, _account uuid', 'internal_only', true, false,
   'tenant_assertion', false, true, 'finance',
   'Internal guard asserting a financial account belongs to the workspace and property.'),
  ('pms_record_payment', '_folio uuid, _amount numeric, _method text, _reference text, _notes text, _intent_key text, _account uuid', 'app_callable', true, false,
   'payment_capture', false, true, 'front_office',
   'Front-desk folio receipt; derives workspace from the folio and validates the receiving account.'),
  ('pos_record_payment_attempt', '_order_id uuid, _amount numeric, _method text, _tendered numeric, _reference text, _shift_id uuid, _idempotency_key text, _manual_confirm boolean, _note text, _account uuid', 'app_callable', true, false,
   'payment_capture', false, true, 'point_of_sale',
   'POS settlement; derives workspace from the order and validates the receiving account.'),
  ('neo_event_billing_record_payment', '_booking uuid, _amount numeric, _entry_type text, _method text, _reference text, _reason text, _account uuid', 'app_callable', true, false,
   'payment_capture', false, true, 'events',
   'Event receipt; derives workspace from the booking and validates the receiving account.'),
  ('neo_delivery_record_payment', '_order uuid, _amount numeric, _method text, _entry_type text, _reference text, _reason text, _account uuid', 'app_callable', true, false,
   'payment_capture', false, true, 'delivery',
   'Delivery receipt; derives workspace from the order and validates the receiving account.'),
  ('neo_ar_record_customer_payment', '_invoice uuid, _amount numeric, _method text, _reference text, _paid_on date, _notes text, _campaign uuid, _intent_key text, _account uuid', 'app_callable', true, false,
   'payment_capture', false, true, 'finance',
   'Accounts-receivable receipt; derives workspace from the invoice and validates the receiving account.')
ON CONFLICT DO NOTHING;