-- NEØ E07-B: Restrict legacy requisition issuing.
-- Apply only after neo_req_issue_safe passes integration tests.
-- Existing issue records are not modified.

REVOKE EXECUTE ON FUNCTION public.req_issue(uuid, jsonb)
FROM PUBLIC, anon, authenticated;

-- Protected issuing remains available to authenticated users.
GRANT EXECUTE ON FUNCTION public.neo_req_issue_safe(uuid, jsonb, uuid)
TO authenticated;