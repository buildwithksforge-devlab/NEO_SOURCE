-- Reporting lines resolve through the canonical role catalogue. Tenant roles
-- created before that link existed have no catalogue reference, so the
-- hierarchy could not resolve a manager for them. This backfills the link by
-- matching the role's own name (never by guessing authority) and keeps it
-- filled for future roles.

CREATE OR REPLACE FUNCTION public.neo_resolve_catalogue_role_key(_name text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH n AS (
    SELECT lower(btrim(regexp_replace(coalesce(_name,''), '[^a-zA-Z0-9]+', ' ', 'g'))) AS norm,
           lower(btrim(regexp_replace(coalesce(_name,''), '[^a-zA-Z0-9]+', '-', 'g'))) AS slug
  )
  SELECT coalesce(
    (SELECT a.role_key FROM public.role_catalogue_aliases a, n
      WHERE a.alias_key = n.norm AND a.ambiguous = false LIMIT 1),
    (SELECT a.role_key FROM public.role_catalogue_aliases a, n
      WHERE lower(btrim(regexp_replace(a.alias_key, '[^a-zA-Z0-9]+', ' ', 'g'))) = n.norm
        AND a.ambiguous = false LIMIT 1),
    (SELECT c.role_key FROM public.role_catalogue c, n WHERE c.role_key = n.slug LIMIT 1),
    (SELECT c.role_key FROM public.role_catalogue c, n
      WHERE lower(btrim(regexp_replace(c.role_name, '[^a-zA-Z0-9]+', ' ', 'g'))) = n.norm LIMIT 1)
  );
$$;

GRANT EXECUTE ON FUNCTION public.neo_resolve_catalogue_role_key(text) TO authenticated, service_role;

-- One active role per catalogue key per workspace. Where several unlinked
-- names resolve to the same catalogue entry, the oldest keeps the link and
-- the rest are left unlinked for an administrator to review.
WITH resolved AS (
  SELECT r.id, r.organization_id, r.created_at,
         public.neo_resolve_catalogue_role_key(r.name) AS key
    FROM public.roles r
   WHERE r.normalized_role_key IS NULL
     AND COALESCE(r.role_status, 'active') = 'active'
), eligible AS (
  SELECT DISTINCT ON (x.organization_id, x.key) x.id, x.organization_id, x.key
    FROM resolved x
   WHERE x.key IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.roles other
        WHERE other.organization_id = x.organization_id
          AND other.id <> x.id
          AND COALESCE(other.role_status, 'active') = 'active'
          AND other.normalized_role_key = x.key
     )
   ORDER BY x.organization_id, x.key, x.created_at, x.id
)
UPDATE public.roles r
   SET normalized_role_key = e.key,
       management_level = COALESCE(
         r.management_level,
         (SELECT c.management_level FROM public.role_catalogue c WHERE c.role_key = e.key)
       )
  FROM eligible e
 WHERE r.id = e.id;

CREATE OR REPLACE FUNCTION public.neo_roles_set_catalogue_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  resolved text;
BEGIN
  IF NEW.normalized_role_key IS NULL THEN
    resolved := public.neo_resolve_catalogue_role_key(NEW.name);
    IF resolved IS NOT NULL THEN
      NEW.normalized_role_key := resolved;
      IF NEW.management_level IS NULL THEN
        SELECT c.management_level INTO NEW.management_level
          FROM public.role_catalogue c WHERE c.role_key = resolved;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_roles_set_catalogue_key ON public.roles;
CREATE TRIGGER neo_roles_set_catalogue_key
  BEFORE INSERT OR UPDATE OF name, normalized_role_key ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.neo_roles_set_catalogue_key();