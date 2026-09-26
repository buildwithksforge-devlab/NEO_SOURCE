
DELETE FROM public.privileged_function_review
 WHERE identity_arguments = ''
   AND function_name IN (
     'neo_partner_invite','neo_partner_claim','neo_partner_access_list','neo_partner_set_access',
     'neo_guest_laundry_pricelist','neo_guest_place_laundry_order','neo_guest_my_laundry',
     'neo_external_transaction_record');

REVOKE EXECUTE ON FUNCTION public.neo_access_rel_no_self_grant() FROM PUBLIC, anon, authenticated;

INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
   review_note, classification, trusts_client_tenant, search_path_fixed, domain)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid),
       CASE
         WHEN p.proname IN ('neo_public_directory','neo_public_property','neo_property_doors') THEN 'public_surface'
         WHEN p.proname = 'neo_access_rel_no_self_grant' THEN 'internal_only'
         WHEN p.proname = 'neo_external_transaction_record' THEN 'internal_only'
         ELSE 'app_callable'
       END,
       p.proname NOT IN ('neo_public_directory','neo_public_property','neo_property_doors',
                         'neo_guest_laundry_pricelist','neo_guest_my_laundry','neo_partner_access_list'),
       false,
       'NEØ unified experience: identity, front door, partner access, stay verification, customer laundry and inbound transaction routines. Access is resolved from the caller''s real relationship with the hotel; none of them grant access to themselves.',
       CASE WHEN p.proname IN ('neo_public_directory','neo_public_property','neo_property_doors')
            THEN 'public_read_only'
            WHEN p.proname IN ('neo_access_rel_no_self_grant','neo_external_transaction_record')
            THEN 'service_role_only'
            ELSE 'caller_verified' END,
       false,
       COALESCE(p.proconfig::text, '') ILIKE '%search_path%',
       'neo_experience'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND NOT EXISTS (
    SELECT 1 FROM public.privileged_function_review r
     WHERE r.function_name = p.proname
       AND r.identity_arguments = pg_get_function_identity_arguments(p.oid)
  );
