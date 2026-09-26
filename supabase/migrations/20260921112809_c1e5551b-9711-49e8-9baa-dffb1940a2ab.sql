
CREATE TABLE IF NOT EXISTS public.neo_partner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  email text NOT NULL,
  contact_name text,
  relationship_type text NOT NULL,
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE CASCADE,
  corporate_account_id uuid REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  invited_by uuid,
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT neo_partner_inv_status_chk CHECK (status IN ('pending','accepted','revoked')),
  CONSTRAINT neo_partner_inv_party_chk CHECK (supplier_id IS NOT NULL OR corporate_account_id IS NOT NULL)
);

GRANT SELECT, INSERT, UPDATE ON public.neo_partner_invitations TO authenticated;
GRANT ALL ON public.neo_partner_invitations TO service_role;

ALTER TABLE public.neo_partner_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS neo_partner_inv_read ON public.neo_partner_invitations;
CREATE POLICY neo_partner_inv_read ON public.neo_partner_invitations
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND is_org_admin_for(organization_id));

DROP POLICY IF EXISTS neo_partner_inv_write ON public.neo_partner_invitations;
CREATE POLICY neo_partner_inv_write ON public.neo_partner_invitations
  FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND is_org_admin_for(organization_id))
  WITH CHECK (organization_id = current_org_id() AND is_org_admin_for(organization_id));

CREATE UNIQUE INDEX IF NOT EXISTS neo_partner_inv_unique
  ON public.neo_partner_invitations (
    branch_id, lower(email),
    COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

DROP TRIGGER IF EXISTS neo_partner_inv_touch ON public.neo_partner_invitations;
CREATE TRIGGER neo_partner_inv_touch BEFORE UPDATE ON public.neo_partner_invitations
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

-- ------------------------------------------------------------------- invite
CREATE OR REPLACE FUNCTION public.neo_partner_invite(
  _branch uuid,
  _email text,
  _relationship_type text,
  _supplier uuid DEFAULT NULL,
  _corporate uuid DEFAULT NULL,
  _contact_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _org uuid;
  _uid uuid := auth.uid();
  _invite uuid;
  _target uuid;
  _name text;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch;
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_property'); END IF;
  IF NOT public.is_org_admin_for(_org) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;
  IF _email IS NULL OR position('@' in _email) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_email');
  END IF;
  IF _supplier IS NULL AND _corporate IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_business');
  END IF;
  IF _supplier IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.suppliers s WHERE s.id = _supplier AND s.organization_id = _org) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'supplier_not_yours');
  END IF;
  IF _corporate IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.corporate_accounts c WHERE c.id = _corporate AND c.organization_id = _org) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'corporate_not_yours');
  END IF;

  SELECT COALESCE(_contact_name,
                  (SELECT name FROM public.suppliers WHERE id = _supplier),
                  (SELECT company_name FROM public.corporate_accounts WHERE id = _corporate))
    INTO _name;

  INSERT INTO public.neo_partner_invitations (
    organization_id, branch_id, email, contact_name, relationship_type,
    supplier_id, corporate_account_id, status, invited_by
  ) VALUES (
    _org, _branch, lower(trim(_email)), _contact_name, _relationship_type,
    _supplier, _corporate, 'pending', _uid
  )
  ON CONFLICT (branch_id, lower(email),
               COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET status = 'pending', relationship_type = EXCLUDED.relationship_type,
                contact_name = COALESCE(EXCLUDED.contact_name, public.neo_partner_invitations.contact_name),
                revoked_at = NULL, revoked_by = NULL, invited_by = _uid
  RETURNING id INTO _invite;

  -- Already a NEØ account with that exact email: grant straight away.
  SELECT u.id INTO _target FROM auth.users u WHERE lower(u.email) = lower(trim(_email)) LIMIT 1;
  IF _target IS NOT NULL THEN
    INSERT INTO public.neo_access_relationships (
      organization_id, branch_id, auth_user_id, door, relationship_type, party_kind,
      party_display_name, supplier_id, corporate_account_id, status, granted_by
    ) VALUES (
      _org, _branch, _target, 'partner', _relationship_type, 'organization',
      _name, _supplier, _corporate, 'active', _uid
    )
    ON CONFLICT (organization_id,
                 COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 auth_user_id, door, relationship_type,
                 COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET status = 'active', revoked_at = NULL, revoked_by = NULL, granted_by = _uid;

    UPDATE public.neo_partner_invitations
       SET status = 'accepted', accepted_by = _target, accepted_at = now()
     WHERE id = _invite;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, _uid, '', 'partner.access.invited', 'administration', _invite::text,
          jsonb_build_object('email', lower(trim(_email)), 'relationship_type', _relationship_type,
                             'supplier_id', _supplier, 'corporate_account_id', _corporate,
                             'granted_immediately', _target IS NOT NULL));

  RETURN jsonb_build_object('ok', true, 'invitation_id', _invite, 'granted', _target IS NOT NULL);
END;
$$;

-- -------------------------------------------------------------------- claim
CREATE OR REPLACE FUNCTION public.neo_partner_claim(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _org uuid;
  _granted int := 0;
  _row record;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  SELECT lower(u.email) INTO _email FROM auth.users u WHERE u.id = _uid;
  IF _email IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_email'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch;
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_property'); END IF;

  FOR _row IN
    SELECT * FROM public.neo_partner_invitations
     WHERE branch_id = _branch AND lower(email) = _email AND status = 'pending'
  LOOP
    INSERT INTO public.neo_access_relationships (
      organization_id, branch_id, auth_user_id, door, relationship_type, party_kind,
      party_display_name, supplier_id, corporate_account_id, status, granted_by
    ) VALUES (
      _row.organization_id, _row.branch_id, _uid, 'partner', _row.relationship_type, 'organization',
      COALESCE(_row.contact_name,
               (SELECT name FROM public.suppliers WHERE id = _row.supplier_id),
               (SELECT company_name FROM public.corporate_accounts WHERE id = _row.corporate_account_id)),
      _row.supplier_id, _row.corporate_account_id, 'active', _row.invited_by
    )
    ON CONFLICT (organization_id,
                 COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 auth_user_id, door, relationship_type,
                 COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET status = 'active', revoked_at = NULL, revoked_by = NULL;

    UPDATE public.neo_partner_invitations
       SET status = 'accepted', accepted_by = _uid, accepted_at = now()
     WHERE id = _row.id;

    _granted := _granted + 1;

    INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
    VALUES (_row.organization_id, _row.branch_id, _uid, '', 'partner.access.claimed', 'administration',
            _row.id::text, jsonb_build_object('email', _email));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'granted', _granted);
END;
$$;

-- ------------------------------------------------------------- list / revoke
CREATE OR REPLACE FUNCTION public.neo_partner_access_list(_branch uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _org uuid;
  _rows jsonb;
BEGIN
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch;
  IF _org IS NULL OR NOT public.is_org_admin_for(_org) THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO _rows
  FROM (
    SELECT i.id, i.email, i.contact_name, i.relationship_type, i.status,
           i.created_at, i.accepted_at, i.revoked_at,
           s.name AS supplier_name, c.company_name AS corporate_name,
           i.supplier_id, i.corporate_account_id,
           (SELECT count(*) FROM public.neo_access_relationships r
             WHERE r.branch_id = i.branch_id
               AND r.auth_user_id = i.accepted_by
               AND r.door = 'partner'
               AND r.status = 'active') AS active_grants
    FROM public.neo_partner_invitations i
    LEFT JOIN public.suppliers s ON s.id = i.supplier_id
    LEFT JOIN public.corporate_accounts c ON c.id = i.corporate_account_id
    WHERE i.branch_id = _branch
  ) t;

  RETURN _rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_partner_set_access(_invitation uuid, _action text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _row public.neo_partner_invitations%ROWTYPE;
  _status text;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  SELECT * INTO _row FROM public.neo_partner_invitations WHERE id = _invitation;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_invitation'); END IF;
  IF NOT public.is_org_admin_for(_row.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;
  IF _action NOT IN ('revoke','suspend','restore') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_action');
  END IF;

  _status := CASE _action WHEN 'revoke' THEN 'revoked' WHEN 'suspend' THEN 'suspended' ELSE 'active' END;

  IF _row.accepted_by IS NOT NULL THEN
    UPDATE public.neo_access_relationships
       SET status = _status,
           revoked_by = CASE WHEN _status = 'active' THEN NULL ELSE _uid END,
           revoked_at = CASE WHEN _status = 'active' THEN NULL ELSE now() END
     WHERE branch_id = _row.branch_id
       AND auth_user_id = _row.accepted_by
       AND door = 'partner'
       AND COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(_row.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND COALESCE(corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(_row.corporate_account_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;

  UPDATE public.neo_partner_invitations
     SET status = CASE WHEN _action = 'revoke' THEN 'revoked'
                       WHEN _action = 'restore' AND accepted_by IS NOT NULL THEN 'accepted'
                       WHEN _action = 'restore' THEN 'pending'
                       ELSE status END,
         revoked_by = CASE WHEN _action = 'restore' THEN NULL ELSE _uid END,
         revoked_at = CASE WHEN _action = 'restore' THEN NULL ELSE now() END
   WHERE id = _invitation;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_row.organization_id, _row.branch_id, _uid, '', 'partner.access.' || _action, 'administration',
          _invitation::text, jsonb_build_object('email', _row.email));

  RETURN jsonb_build_object('ok', true, 'status', _status);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_partner_invite(uuid, text, text, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_partner_claim(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_partner_access_list(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_partner_set_access(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_invite(uuid, text, text, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_partner_claim(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_partner_access_list(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_partner_set_access(uuid, text) TO authenticated, service_role;
