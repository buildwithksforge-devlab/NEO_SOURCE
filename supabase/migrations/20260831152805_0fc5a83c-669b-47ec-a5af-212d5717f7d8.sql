REVOKE ALL ON FUNCTION public.neo_finance_canonical_mark_posted(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_journal_canonical_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_receipt_canonical_sync() FROM PUBLIC, anon, authenticated;