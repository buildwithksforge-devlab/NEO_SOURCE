REVOKE ALL ON FUNCTION public.neo_procurement_receiving_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_hr_employee_movement(uuid, text, date, text, uuid, uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_hr_document_record(uuid, text, text, text, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_hr_case_open(text, uuid, text, text, text, date, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_hr_case_review(text, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_employee_movement(uuid, text, date, text, uuid, uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_document_record(uuid, text, text, text, date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_case_open(text, uuid, text, text, text, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_case_review(text, uuid, text, text, text) TO authenticated;