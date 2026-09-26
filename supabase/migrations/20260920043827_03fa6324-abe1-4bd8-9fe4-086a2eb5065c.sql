
CREATE TABLE IF NOT EXISTS public.person_duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('customer','employee')),
  primary_id uuid NOT NULL,
  duplicate_id uuid NOT NULL,
  match_score numeric NOT NULL DEFAULT 0,
  match_reasons text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','merged')),
  decision_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  merged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_duplicate_distinct CHECK (primary_id <> duplicate_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS person_duplicate_pair_uidx
  ON public.person_duplicate_candidates(organization_id, entity_type, least(primary_id, duplicate_id), greatest(primary_id, duplicate_id));
CREATE INDEX IF NOT EXISTS person_duplicate_status_idx
  ON public.person_duplicate_candidates(organization_id, entity_type, status, match_score DESC);

GRANT SELECT, INSERT, UPDATE ON public.person_duplicate_candidates TO authenticated;
GRANT ALL ON public.person_duplicate_candidates TO service_role;

ALTER TABLE public.person_duplicate_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY person_duplicate_select ON public.person_duplicate_candidates FOR SELECT TO authenticated
  USING (organization_id = current_org_id());

CREATE POLICY person_duplicate_manage ON public.person_duplicate_candidates FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND (
      has_permission('crm','customers.manage') OR has_permission('hr','employees.manage') OR is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = current_org_id() AND (
      has_permission('crm','customers.manage') OR has_permission('hr','employees.manage') OR is_org_admin_for(organization_id)));

CREATE TRIGGER person_duplicate_touch BEFORE UPDATE ON public.person_duplicate_candidates
  FOR EACH ROW EXECUTE FUNCTION public.neo_touch_updated_at();

CREATE OR REPLACE FUNCTION public.neo_normalise_phone(_p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(right(regexp_replace(coalesce(_p,''), '[^0-9]', '', 'g'), 9), '')
$$;

CREATE OR REPLACE FUNCTION public.neo_scan_person_duplicates(_entity_type text DEFAULT 'customer')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := current_org_id(); found integer := 0; inserted integer := 0;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'No active workspace'; END IF;
  IF NOT (has_permission('crm','customers.manage') OR has_permission('hr','employees.manage') OR is_org_admin_for(org)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF _entity_type = 'customer' THEN
    WITH people AS (
      SELECT c.id, c.full_name, lower(nullif(trim(c.email),'')) AS email,
             neo_normalise_phone(c.phone) AS phone,
             (SELECT array_agg(DISTINCT lower(i.document_type||':'||i.masked_number))
                FROM customer_identifiers i WHERE i.customer_id = c.id AND i.masked_number IS NOT NULL) AS docs
      FROM customers c
      WHERE c.organization_id = org AND c.merged_into_id IS NULL AND c.archived_at IS NULL
    ), pairs AS (
      SELECT a.id AS primary_id, b.id AS duplicate_id,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN a.email IS NOT NULL AND a.email = b.email THEN 'email' END,
               CASE WHEN a.phone IS NOT NULL AND a.phone = b.phone THEN 'phone' END,
               CASE WHEN a.docs && b.docs THEN 'identifier' END,
               CASE WHEN lower(a.full_name) = lower(b.full_name) THEN 'name' END
             ], NULL) AS reasons,
             jsonb_build_object('primary_name', a.full_name, 'duplicate_name', b.full_name) AS evidence
      FROM people a JOIN people b ON a.id < b.id
      WHERE (a.email IS NOT NULL AND a.email = b.email)
         OR (a.phone IS NOT NULL AND a.phone = b.phone)
         OR (a.docs && b.docs)
    ), scored AS (
      SELECT primary_id, duplicate_id, reasons, evidence,
             least(1.0, (CASE WHEN 'identifier' = ANY(reasons) THEN 0.6 ELSE 0 END)
                      + (CASE WHEN 'email' = ANY(reasons) THEN 0.3 ELSE 0 END)
                      + (CASE WHEN 'phone' = ANY(reasons) THEN 0.3 ELSE 0 END)
                      + (CASE WHEN 'name' = ANY(reasons) THEN 0.2 ELSE 0 END))::numeric AS score
      FROM pairs
    ), ins AS (
      INSERT INTO person_duplicate_candidates(organization_id, entity_type, primary_id, duplicate_id, match_score, match_reasons, evidence)
      SELECT org, 'customer', primary_id, duplicate_id, score, reasons, evidence FROM scored
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM scored), (SELECT count(*) FROM ins) INTO found, inserted;
  ELSIF _entity_type = 'employee' THEN
    WITH people AS (
      SELECT e.id, e.full_name,
             lower(coalesce(nullif(trim(e.work_email),''), nullif(trim(e.personal_email),''))) AS email,
             neo_normalise_phone(e.phone) AS phone,
             (SELECT array_agg(DISTINCT lower(x))
                FROM employee_identifiers ei,
                     LATERAL unnest(ARRAY[ei.national_id, ei.passport_number, ei.tax_pin]) AS x
               WHERE ei.employee_id = e.id AND x IS NOT NULL) AS docs
      FROM employees e WHERE e.organization_id = org
    ), pairs AS (
      SELECT a.id AS primary_id, b.id AS duplicate_id,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN a.email IS NOT NULL AND a.email = b.email THEN 'email' END,
               CASE WHEN a.phone IS NOT NULL AND a.phone = b.phone THEN 'phone' END,
               CASE WHEN a.docs && b.docs THEN 'identifier' END,
               CASE WHEN lower(a.full_name) = lower(b.full_name) THEN 'name' END
             ], NULL) AS reasons,
             jsonb_build_object('primary_name', a.full_name, 'duplicate_name', b.full_name) AS evidence
      FROM people a JOIN people b ON a.id < b.id
      WHERE (a.email IS NOT NULL AND a.email = b.email)
         OR (a.phone IS NOT NULL AND a.phone = b.phone)
         OR (a.docs && b.docs)
    ), scored AS (
      SELECT primary_id, duplicate_id, reasons, evidence,
             least(1.0, (CASE WHEN 'identifier' = ANY(reasons) THEN 0.6 ELSE 0 END)
                      + (CASE WHEN 'email' = ANY(reasons) THEN 0.3 ELSE 0 END)
                      + (CASE WHEN 'phone' = ANY(reasons) THEN 0.3 ELSE 0 END)
                      + (CASE WHEN 'name' = ANY(reasons) THEN 0.2 ELSE 0 END))::numeric AS score
      FROM pairs
    ), ins AS (
      INSERT INTO person_duplicate_candidates(organization_id, entity_type, primary_id, duplicate_id, match_score, match_reasons, evidence)
      SELECT org, 'employee', primary_id, duplicate_id, score, reasons, evidence FROM scored
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM scored), (SELECT count(*) FROM ins) INTO found, inserted;
  ELSE
    RAISE EXCEPTION 'Unsupported entity type %', _entity_type;
  END IF;

  RETURN jsonb_build_object('entity_type', _entity_type, 'matches_found', found, 'new_candidates', inserted);
END $$;

CREATE OR REPLACE FUNCTION public.neo_review_person_duplicate(_candidate uuid, _decision text, _note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.person_duplicate_candidates;
BEGIN
  SELECT * INTO c FROM person_duplicate_candidates WHERE id = _candidate;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Candidate belongs to another workspace'; END IF;
  IF NOT (has_permission('crm','customers.manage') OR has_permission('hr','employees.manage') OR is_org_admin_for(c.organization_id)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;
  IF _decision NOT IN ('confirmed','rejected') THEN RAISE EXCEPTION 'Decision must be confirmed or rejected'; END IF;
  IF c.status = 'merged' THEN RAISE EXCEPTION 'Candidate already merged'; END IF;
  IF coalesce(trim(_note),'') = '' THEN RAISE EXCEPTION 'A written judgement is required'; END IF;

  UPDATE person_duplicate_candidates
     SET status = _decision, decision_note = _note, reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = _candidate;

  RETURN jsonb_build_object('candidate', _candidate, 'status', _decision);
END $$;

CREATE OR REPLACE FUNCTION public.neo_merge_person_duplicate(_candidate uuid, _survivor uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.person_duplicate_candidates; loser uuid; rel record; moved jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; n integer;
BEGIN
  SELECT * INTO c FROM person_duplicate_candidates WHERE id = _candidate;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Candidate belongs to another workspace'; END IF;
  IF c.entity_type <> 'customer' THEN RAISE EXCEPTION 'Only guest/customer records can be merged here'; END IF;
  IF c.status <> 'confirmed' THEN RAISE EXCEPTION 'Candidate must be reviewed and confirmed before merging'; END IF;
  IF NOT (has_permission('crm','customers.manage') OR is_org_admin_for(c.organization_id)) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A merge reason is required'; END IF;
  IF _survivor NOT IN (c.primary_id, c.duplicate_id) THEN RAISE EXCEPTION 'Surviving record must be one of the matched records'; END IF;
  loser := CASE WHEN _survivor = c.primary_id THEN c.duplicate_id ELSE c.primary_id END;

  FOR rel IN
    SELECT k.table_name FROM information_schema.columns k
     WHERE k.table_schema = 'public' AND k.column_name = 'customer_id'
       AND k.table_name <> 'customer_merge_history'
       AND EXISTS (SELECT 1 FROM pg_class pc JOIN pg_namespace pn ON pn.oid=pc.relnamespace
                    WHERE pn.nspname='public' AND pc.relname=k.table_name AND pc.relkind IN ('r','p'))
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET customer_id = $1 WHERE customer_id = $2', rel.table_name)
        USING _survivor, loser;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN moved := moved || jsonb_build_object('table', rel.table_name, 'rows', n); END IF;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped || jsonb_build_object('table', rel.table_name, 'error', SQLERRM);
    END;
  END LOOP;

  INSERT INTO customer_merge_history(organization_id, surviving_customer_id, merged_customer_id, reason, snapshot, performed_by)
  SELECT c.organization_id, _survivor, loser, _reason,
         jsonb_build_object('candidate', _candidate, 'merged_record', to_jsonb(cu), 'moved', moved, 'skipped', skipped),
         auth.uid()
    FROM customers cu WHERE cu.id = loser;

  UPDATE customers SET merged_into_id = _survivor, archived_at = now(), account_status = 'merged', updated_at = now()
   WHERE id = loser;

  UPDATE person_duplicate_candidates
     SET status='merged', merged_at=now(), reviewed_by=auth.uid(), reviewed_at=now(),
         evidence = evidence || jsonb_build_object('survivor', _survivor, 'merged', loser, 'moved', moved, 'skipped', skipped)
   WHERE id = _candidate;

  RETURN jsonb_build_object('survivor', _survivor, 'merged', loser, 'moved', moved, 'skipped', skipped);
END $$;

REVOKE ALL ON FUNCTION public.neo_scan_person_duplicates(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_review_person_duplicate(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_merge_person_duplicate(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_scan_person_duplicates(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_review_person_duplicate(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_merge_person_duplicate(uuid,uuid,text) TO authenticated;
