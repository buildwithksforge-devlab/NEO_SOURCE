
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
                  (SELECT NULLIF(trading_name, '') FROM public.corporate_accounts WHERE id = _corporate),
                  (SELECT legal_name FROM public.corporate_accounts WHERE id = _corporate))
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
               (SELECT NULLIF(trading_name, '') FROM public.corporate_accounts WHERE id = _row.corporate_account_id),
               (SELECT legal_name FROM public.corporate_accounts WHERE id = _row.corporate_account_id)),
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
           s.name AS supplier_name,
           COALESCE(NULLIF(c.trading_name, ''), c.legal_name) AS corporate_name,
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
