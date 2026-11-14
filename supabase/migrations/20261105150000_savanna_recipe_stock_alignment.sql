CREATE TEMP TABLE neo_recipe_link_repair_candidates
ON COMMIT DROP
AS
WITH target_branch AS (
    SELECT
        b.id,
        b.organization_id
    FROM public.branches b
    WHERE lower(trim(b.name)) =
          lower(trim('Savanna Crown Nairobi'))
    LIMIT 1
)
SELECT
    ri.id AS component_id,
    r.id AS recipe_id,
    mi.id AS menu_item_id,
    mi.name AS menu_item_name,
    mi.sku AS menu_sku,
    ri.ingredient_name,
    ri.unit AS component_unit,
    matched.stock_item_id,
    matched.stock_sku,
    matched.stock_name,
    matched.base_unit
FROM target_branch tb
JOIN public.menu_items mi
  ON mi.organization_id = tb.organization_id
 AND (
     mi.branch_id = tb.id
     OR mi.branch_id IS NULL
 )
JOIN LATERAL (
    SELECT candidate_recipe.*
    FROM public.recipes candidate_recipe
    WHERE candidate_recipe.organization_id =
          tb.organization_id
      AND candidate_recipe.menu_item_id = mi.id
      AND candidate_recipe.status = 'active'
    ORDER BY
        candidate_recipe.version DESC NULLS LAST,
        candidate_recipe.created_at DESC
    LIMIT 1
) r ON true
JOIN public.recipe_ingredients ri
  ON ri.recipe_id = r.id
 AND ri.component_type = 'stock_item'
LEFT JOIN LATERAL (
    SELECT
        count(*)::integer AS match_count,
        (array_agg(si.id ORDER BY si.id))[1]
            AS stock_item_id,
        (array_agg(si.sku ORDER BY si.id))[1]
            AS stock_sku,
        (array_agg(si.name ORDER BY si.id))[1]
            AS stock_name,
        (array_agg(si.base_unit ORDER BY si.id))[1]
            AS base_unit
    FROM public.stock_items si
    WHERE si.organization_id = tb.organization_id
      AND lower(
          regexp_replace(
              trim(si.name),
              '\s+',
              ' ',
              'g'
          )
      ) = lower(
          regexp_replace(
              trim(ri.ingredient_name),
              '\s+',
              ' ',
              'g'
          )
      )
) matched ON true
WHERE coalesce(mi.consumption_mode, 'none') = 'recipe'
  AND ri.stock_item_id IS NULL
  AND matched.match_count = 1
  AND lower(trim(ri.unit)) =
      lower(trim(matched.base_unit))
  AND coalesce(mi.sku, '') NOT LIKE 'CERT-%'
  AND coalesce(mi.sku, '') NOT LIKE 'NEO-%';


CREATE TEMP TABLE neo_recipe_station_repair_candidates
ON COMMIT DROP
AS
WITH target_branch AS (
    SELECT
        b.id,
        b.organization_id
    FROM public.branches b
    WHERE lower(trim(b.name)) =
          lower(trim('Savanna Crown Nairobi'))
    LIMIT 1
)
SELECT
    r.id AS recipe_id,
    mi.id AS menu_item_id,
    mi.name AS menu_item_name,
    mi.sku AS menu_sku,
    nullif(
        routing.result ->> 'station_id',
        ''
    )::uuid AS station_id,
    routing.result ->> 'source'
        AS station_source
FROM target_branch tb
JOIN public.menu_items mi
  ON mi.organization_id = tb.organization_id
 AND (
     mi.branch_id = tb.id
     OR mi.branch_id IS NULL
 )
JOIN LATERAL (
    SELECT candidate_recipe.*
    FROM public.recipes candidate_recipe
    WHERE candidate_recipe.organization_id =
          tb.organization_id
      AND candidate_recipe.menu_item_id = mi.id
      AND candidate_recipe.status = 'active'
    ORDER BY
        candidate_recipe.version DESC NULLS LAST,
        candidate_recipe.created_at DESC
    LIMIT 1
) r ON true
LEFT JOIN LATERAL (
    SELECT public.neo_kitchen_resolve_station(
        tb.organization_id,
        coalesce(mi.branch_id, tb.id),
        mi.id,
        mi.category_id,
        NULL,
        NULL
    ) AS result
) routing ON true
WHERE coalesce(mi.consumption_mode, 'none') = 'recipe'
  AND r.station_id IS NULL
  AND nullif(
      routing.result ->> 'station_id',
      ''
  ) IS NOT NULL
  AND coalesce(mi.sku, '') NOT LIKE 'CERT-%'
  AND coalesce(mi.sku, '') NOT LIKE 'NEO-%';


DO $$
DECLARE
    link_count integer;
    link_menu_count integer;
    station_count integer;
BEGIN
    SELECT
        count(*),
        count(DISTINCT menu_item_id)
    INTO
        link_count,
        link_menu_count
    FROM neo_recipe_link_repair_candidates;

    SELECT count(*)
    INTO station_count
    FROM neo_recipe_station_repair_candidates;

    IF link_count <> 54 THEN
        RAISE EXCEPTION
            'Expected 54 safe component links; found %.',
            link_count;
    END IF;

    IF link_menu_count <> 18 THEN
        RAISE EXCEPTION
            'Expected 18 affected menu items; found %.',
            link_menu_count;
    END IF;

    IF station_count <> 13 THEN
        RAISE EXCEPTION
            'Expected 13 missing recipe stations; found %.',
            station_count;
    END IF;
END
$$;


UPDATE public.recipe_ingredients ri
SET stock_item_id = candidate.stock_item_id
FROM neo_recipe_link_repair_candidates candidate
WHERE ri.id = candidate.component_id
  AND ri.stock_item_id IS NULL;


UPDATE public.recipes r
SET station_id = candidate.station_id
FROM neo_recipe_station_repair_candidates candidate
WHERE r.id = candidate.recipe_id
  AND r.station_id IS NULL;


WITH target_branch AS (
    SELECT
        b.id,
        b.organization_id
    FROM public.branches b
    WHERE lower(trim(b.name)) =
          lower(trim('Savanna Crown Nairobi'))
    LIMIT 1
),
active_recipe_menu AS (
    SELECT
        tb.id AS branch_id,
        tb.organization_id,
        mi.id AS menu_item_id,
        mi.name AS menu_item_name,
        mi.sku AS menu_sku,
        mi.category_id,
        r.id AS recipe_id,
        r.station_id AS recipe_station_id,
        routing.result AS route_result
    FROM target_branch tb
    JOIN public.menu_items mi
      ON mi.organization_id = tb.organization_id
     AND (
         mi.branch_id = tb.id
         OR mi.branch_id IS NULL
     )
    JOIN LATERAL (
        SELECT candidate_recipe.*
        FROM public.recipes candidate_recipe
        WHERE candidate_recipe.organization_id =
              tb.organization_id
          AND candidate_recipe.menu_item_id = mi.id
          AND candidate_recipe.status = 'active'
        ORDER BY
            candidate_recipe.version DESC NULLS LAST,
            candidate_recipe.created_at DESC
        LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
        SELECT public.neo_kitchen_resolve_station(
            tb.organization_id,
            coalesce(mi.branch_id, tb.id),
            mi.id,
            mi.category_id,
            NULL,
            NULL
        ) AS result
    ) routing ON true
    WHERE coalesce(mi.consumption_mode, 'none') = 'recipe'
      AND coalesce(mi.sku, '') NOT LIKE 'CERT-%'
      AND coalesce(mi.sku, '') NOT LIKE 'NEO-%'
),
validation AS (
    SELECT
        (
            SELECT count(*)
            FROM neo_recipe_link_repair_candidates c
            JOIN public.recipe_ingredients ri
              ON ri.id = c.component_id
             AND ri.stock_item_id = c.stock_item_id
        ) AS links_applied,

        (
            SELECT count(*)
            FROM neo_recipe_station_repair_candidates c
            JOIN public.recipes r
              ON r.id = c.recipe_id
             AND r.station_id = c.station_id
        ) AS stations_applied,

        (
            SELECT count(*)
            FROM active_recipe_menu arm
            JOIN public.recipe_ingredients ri
              ON ri.recipe_id = arm.recipe_id
             AND ri.component_type = 'stock_item'
            WHERE ri.stock_item_id IS NULL
        ) AS remaining_missing_links,

        (
            SELECT count(*)
            FROM active_recipe_menu arm
            WHERE arm.recipe_station_id IS NULL
        ) AS remaining_missing_stations,

        (
            SELECT count(*)
            FROM active_recipe_menu arm
            WHERE arm.recipe_station_id IS NOT NULL
              AND nullif(
                  arm.route_result ->> 'station_id',
                  ''
              ) IS NOT NULL
              AND arm.recipe_station_id <>
                  nullif(
                      arm.route_result ->> 'station_id',
                      ''
                  )::uuid
        ) AS preserved_station_disagreements,

        (
            SELECT count(*)
            FROM public.recipe_ingredients ri
            JOIN public.recipes r
              ON r.id = ri.recipe_id
            JOIN public.menu_items mi
              ON mi.id = r.menu_item_id
            JOIN target_branch tb
              ON mi.organization_id =
                 tb.organization_id
            WHERE (
                mi.name = 'Full Breakfast'
                AND ri.ingredient_name = 'Avocado (Piece)'
                AND ri.quantity = 100
                AND lower(ri.unit) = 'g'
            ) OR (
                mi.name = 'Full Breakfast'
                AND ri.ingredient_name =
                    'Beef Mince (SCN) (g)'
                AND ri.quantity = 100
                AND lower(ri.unit) = 'kg'
            ) OR (
                mi.name = 'Sirloin Steak 375g'
                AND ri.ingredient_name =
                    'Cooking Oil (SCN) (ml)'
                AND ri.quantity = 30
                AND lower(ri.unit) = 'l'
            )
        ) AS unsafe_rows_untouched
)
SELECT
    check_name,
    expected,
    actual,
    actual = expected AS passed,
    detail
FROM validation v
CROSS JOIN LATERAL (
    VALUES
        (
            'safe stock links applied',
            54,
            v.links_applied,
            'Exact name and exact unit only'
        ),
        (
            'missing recipe stations filled',
            13,
            v.stations_applied,
            'Only previously-null stations'
        ),
        (
            'remaining production stock links missing',
            0,
            v.remaining_missing_links,
            'Savanna active recipe-mode items'
        ),
        (
            'remaining production recipe stations missing',
            0,
            v.remaining_missing_stations,
            'Savanna active recipe-mode items'
        ),
        (
            'station disagreements preserved',
            5,
            v.preserved_station_disagreements,
            'No existing station was overwritten'
        ),
        (
            'unsafe quantity/unit rows untouched',
            3,
            v.unsafe_rows_untouched,
            'Full Breakfast and Sirloin rows excluded'
        )
) result(
    check_name,
    expected,
    actual,
    detail
)
ORDER BY check_name;
