ALTER TABLE public.integration_providers
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS connection_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS declaration_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS declared_at timestamptz,
  ADD COLUMN IF NOT EXISTS declared_by uuid,
  ADD COLUMN IF NOT EXISTS support_contact text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_providers_declaration_status_check'
  ) THEN
    ALTER TABLE public.integration_providers
      ADD CONSTRAINT integration_providers_declaration_status_check
      CHECK (declaration_status IN ('draft', 'declared', 'withdrawn'));
  END IF;
END $$;

-- Providers that already carry a usable declaration keep working unchanged.
UPDATE public.integration_providers
SET declaration_status = 'declared',
    declared_at = COALESCE(declared_at, created_at)
WHERE declaration_status = 'draft'
  AND category IS NOT NULL
  AND COALESCE(array_length(required_secret_names, 1), 0) > 0;

CREATE OR REPLACE FUNCTION public.neo_provider_declare(
  _code text,
  _name text,
  _category text,
  _purpose text,
  _capabilities text[],
  _requirements jsonb,
  _required_secret_names text[] DEFAULT '{}',
  _documentation_url text DEFAULT NULL,
  _support_contact text DEFAULT NULL,
  _supports_webhooks boolean DEFAULT false,
  _supports_sandbox boolean DEFAULT false,
  _requires_partner_approval boolean DEFAULT false
)
RETURNS public.integration_providers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.integration_providers;
  v_req jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only a platform administrator may declare an integration provider';
  END IF;
  IF coalesce(btrim(_code), '') = '' OR coalesce(btrim(_name), '') = '' THEN
    RAISE EXCEPTION 'A provider needs a code and a name';
  END IF;
  IF coalesce(btrim(_category), '') = '' THEN
    RAISE EXCEPTION 'A provider must declare its category';
  END IF;
  IF coalesce(array_length(_capabilities, 1), 0) = 0 THEN
    RAISE EXCEPTION 'A provider must declare at least one capability';
  END IF;
  IF jsonb_typeof(coalesce(_requirements, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(_requirements, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'A provider must declare what it requires before it can be connected';
  END IF;
  FOR v_req IN SELECT * FROM jsonb_array_elements(_requirements) LOOP
    IF coalesce(btrim(v_req->>'key'), '') = '' OR coalesce(btrim(v_req->>'label'), '') = '' THEN
      RAISE EXCEPTION 'Every connection requirement needs a key and a label';
    END IF;
    IF coalesce(v_req->>'kind', '') NOT IN ('secret', 'setting', 'evidence') THEN
      RAISE EXCEPTION 'Requirement % must be a secret, a setting or evidence', v_req->>'key';
    END IF;
  END LOOP;

  INSERT INTO public.integration_providers AS p (
    code, name, category, purpose, capabilities, connection_requirements,
    required_secret_names, documentation_url, support_contact,
    supports_webhooks, supports_sandbox, requires_partner_approval,
    declaration_status, declared_at, declared_by, active
  ) VALUES (
    btrim(_code), btrim(_name), btrim(_category), _purpose, _capabilities, _requirements,
    coalesce(_required_secret_names, '{}'), _documentation_url, _support_contact,
    _supports_webhooks, _supports_sandbox, _requires_partner_approval,
    'declared', now(), auth.uid(), true
  )
  ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    purpose = EXCLUDED.purpose,
    capabilities = EXCLUDED.capabilities,
    connection_requirements = EXCLUDED.connection_requirements,
    required_secret_names = EXCLUDED.required_secret_names,
    documentation_url = EXCLUDED.documentation_url,
    support_contact = EXCLUDED.support_contact,
    supports_webhooks = EXCLUDED.supports_webhooks,
    supports_sandbox = EXCLUDED.supports_sandbox,
    requires_partner_approval = EXCLUDED.requires_partner_approval,
    declaration_status = 'declared',
    declared_at = now(),
    declared_by = auth.uid(),
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_provider_declare(text, text, text, text, text[], jsonb, text[], text, text, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_provider_declare(text, text, text, text, text[], jsonb, text[], text, text, boolean, boolean, boolean) TO authenticated;