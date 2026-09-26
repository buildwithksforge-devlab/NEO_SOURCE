UPDATE public.operational_stations
   SET active = false, updated_at = now()
 WHERE id = 'eea17bc2-191e-4f76-9036-6722dc1bf440'
   AND active;

REVOKE EXECUTE ON FUNCTION public.neo_beo_on_booking_confirmed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_requisition_shortage_to_purchase() FROM PUBLIC, anon, authenticated;