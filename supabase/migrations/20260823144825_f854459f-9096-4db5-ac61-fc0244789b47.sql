-- UAT Scenario 2 defect: station production roles carried access_scope 'self',
-- which made the kitchen display blind — a line chef could not see any ticket
-- routed to their own station because 'self' only exposes records assigned to
-- or created by the user. Station-bound production roles must be 'team' scope,
-- which is still isolated station-by-station (Hot Kitchen cannot see Pastry).

UPDATE public.role_catalogue
   SET access_scope = 'team', updated_at = now()
 WHERE role_key IN ('hot-kitchen-chef','pastry-chef','kitchen-steward','bar-attendant','barista')
   AND access_scope <> 'team';

UPDATE public.roles
   SET access_scope = 'team', updated_at = now()
 WHERE normalized_role_key IN ('hot-kitchen-chef','pastry-chef','kitchen-steward','bar-attendant','barista')
   AND coalesce(access_scope,'self') <> 'team';