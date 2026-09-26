
REVOKE EXECUTE ON FUNCTION public.neo_guest_verify_stay(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_guest_my_stays(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_partner_context(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_partner_records(uuid, uuid) FROM anon;
