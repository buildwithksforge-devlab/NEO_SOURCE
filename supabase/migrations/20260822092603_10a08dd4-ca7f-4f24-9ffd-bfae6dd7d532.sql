CREATE OR REPLACE FUNCTION public.neo_notify_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending_approval' THEN
    PERFORM public.neo_notify(NEW.organization_id, NEW.approver_id, NEW.branch_id, 'approvals',
      format('Approval required: %s', coalesce(NEW.approval_type,'request')),
      coalesce(NEW.reason, 'A request is waiting for your decision.'),
      '/approvals?request=' || NEW.id::text, 'high', true,
      'approvals', NEW.id, 'approval.requested', 'approval:' || NEW.id::text || ':requested');
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_notify_approval() FROM PUBLIC, anon, authenticated;