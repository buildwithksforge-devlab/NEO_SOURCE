
REVOKE EXECUTE ON FUNCTION public.neo_external_transaction_record(uuid, uuid, text, text, text, numeric, text, timestamptz, jsonb) FROM authenticated;

INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context, review_note, classification, trusts_client_tenant, search_path_fixed, domain)
SELECT v.fn, '', v.reach, v.sensitive, false, v.note, v.classification, false, true, v.domain
FROM (VALUES
  ('neo_partner_invite', 'app_callable', true, 'Hotel administrator grants partner portal access to a named business contact.', 'caller_verified', 'administration'),
  ('neo_partner_claim', 'app_callable', true, 'Signed-in person claims only an invitation issued to their own verified email.', 'caller_verified', 'administration'),
  ('neo_partner_access_list', 'app_callable', false, 'Hotel administrator lists partner access for one property.', 'caller_verified', 'administration'),
  ('neo_partner_set_access', 'app_callable', true, 'Hotel administrator suspends, withdraws or restores partner access.', 'caller_verified', 'administration'),
  ('neo_guest_laundry_pricelist', 'app_callable', false, 'Reads the published laundry price list where the service is switched on.', 'caller_verified', 'laundry'),
  ('neo_guest_place_laundry_order', 'app_callable', true, 'Creates a canonical laundry order for the signed-in customer, priced server-side.', 'caller_verified', 'laundry'),
  ('neo_guest_my_laundry', 'app_callable', false, 'Returns only the signed-in customer own laundry orders.', 'caller_verified', 'laundry'),
  ('neo_external_transaction_record', 'internal_only', true, 'Records an inbound provider transaction once, blocking duplicate references.', 'service_role_only', 'finance')
) AS v(fn, reach, sensitive, note, classification, domain)
WHERE NOT EXISTS (
  SELECT 1 FROM public.privileged_function_review r
   WHERE r.function_name = v.fn AND r.identity_arguments = ''
);
