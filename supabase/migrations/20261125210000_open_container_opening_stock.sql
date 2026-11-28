BEGIN;

CREATE OR REPLACE FUNCTION public.neo_register_opening_container(
    _item uuid,
    _location uuid,
    _remaining_ml numeric,
    _container_count integer,
    _remaining_value numeric,
    _reference uuid,
    _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_item public.stock_items;
    v_location public.stock_locations;
    v_pool public.stock_open_containers;
    v_existing public.stock_container_events;
    v_key text;
    v_event uuid;
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR (
           public.is_org_admin() IS TRUE
           OR public.has_permission(
               'inventory','stock.manage'
           ) IS TRUE
       ) IS NOT TRUE
    THEN
        RAISE EXCEPTION 'Opening stock permission required'
            USING ERRCODE = '42501';
    END IF;

    IF _reference IS NULL
       OR _remaining_ml IS NULL
       OR _remaining_ml <= 0
       OR _remaining_ml::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _container_count IS NULL
       OR _container_count <= 0
       OR length(btrim(coalesce(_reason,''))) < 3
    THEN
        RAISE EXCEPTION 'Invalid opening container details'
            USING ERRCODE = '22023';
    END IF;

    IF _remaining_value IS NOT NULL
       AND (
           _remaining_value < 0
           OR _remaining_value::text IN (
               'NaN','Infinity','-Infinity'
           )
       )
    THEN
        RAISE EXCEPTION 'Invalid opening stock valuation';
    END IF;

    SELECT *
    INTO v_item
    FROM public.stock_items
    WHERE id = _item
      AND organization_id = v_org;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock item unavailable';
    END IF;

    IF (
        v_item.may_open_for_pours IS TRUE
        AND v_item.tracking_method IN ('volume','both')
        AND v_item.container_volume_ml > 0
        AND v_item.container_volume_ml::text NOT IN (
            'NaN','Infinity','-Infinity'
        )
    ) IS NOT TRUE THEN
        RAISE EXCEPTION
            'Stock item is not configured for measured pours';
    END IF;

    IF coalesce(
        (to_jsonb(v_item)->>'active')::boolean,
        true
    ) IS NOT TRUE THEN
        RAISE EXCEPTION 'Inactive stock item';
    END IF;

    IF _remaining_ml >
       v_item.container_volume_ml * _container_count
    THEN
        RAISE EXCEPTION
            'Remaining volume exceeds container capacity';
    END IF;

    SELECT *
    INTO v_location
    FROM public.stock_locations
    WHERE id = _location
      AND organization_id = v_org
      AND active IS TRUE;

    IF NOT FOUND
       OR public.neo_branch_in_scope(
           v_location.branch_id
       ) IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Stock location outside authorised scope'
            USING ERRCODE = '42501';
    END IF;

    IF v_item.branch_id IS NOT NULL
       AND v_item.branch_id
           IS DISTINCT FROM v_location.branch_id
    THEN
        RAISE EXCEPTION
            'Stock item belongs to another property'
            USING ERRCODE = '42501';
    END IF;

    v_key := 'opening-container:' || _reference::text;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'neo-container-event:' || v_org::text ||
            ':' || v_key,0
        )
    );

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'neo-container-pool:' || v_org::text ||
            ':' || _item::text ||
            ':' || _location::text,0
        )
    );

    SELECT *
    INTO v_existing
    FROM public.stock_container_events
    WHERE organization_id = v_org
      AND idempotency_key = v_key;

    IF FOUND THEN

        IF v_existing.stock_item_id IS DISTINCT FROM _item
           OR v_existing.location_id IS DISTINCT FROM _location
           OR v_existing.volume_delta_ml
               IS DISTINCT FROM _remaining_ml
           OR v_existing.containers_delta
               IS DISTINCT FROM _container_count
           OR v_existing.inventory_value_delta
               IS DISTINCT FROM _remaining_value
           OR v_existing.reference_type
                IS DISTINCT FROM 'opening_stock'
           OR v_existing.reason
                IS DISTINCT FROM btrim(_reason)
        THEN
            RAISE EXCEPTION 'Opening stock identity conflict';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'status','already-recorded',
            'event_id',v_existing.id
        );

    END IF;

    INSERT INTO public.stock_open_containers (
        organization_id,
        branch_id,
        stock_item_id,
        location_id,
        open_volume_ml,
        containers_open,
        open_inventory_value,
        valuation_volume_ml
    )
    VALUES (
        v_org,
        v_location.branch_id,
        _item,
        _location,
        0,
        0,
        0,
        0
    )
    ON CONFLICT (stock_item_id,location_id)
    DO NOTHING;

    SELECT *
    INTO STRICT v_pool
    FROM public.stock_open_containers
    WHERE stock_item_id = _item
      AND location_id = _location
      AND organization_id = v_org
    FOR UPDATE;

    IF v_pool.branch_id
       IS DISTINCT FROM v_location.branch_id
    THEN
        RAISE EXCEPTION 'Container property mismatch';
    END IF;

    UPDATE public.stock_open_containers
    SET
        open_inventory_value = CASE
            WHEN _remaining_value IS NULL THEN NULL
            WHEN v_pool.open_volume_ml = 0
                THEN _remaining_value
            WHEN v_pool.open_inventory_value IS NOT NULL
             AND v_pool.valuation_volume_ml =
                 v_pool.open_volume_ml
                THEN v_pool.open_inventory_value
                     + _remaining_value
            ELSE NULL
        END,

        valuation_volume_ml = CASE
            WHEN _remaining_value IS NOT NULL
             AND (
                 v_pool.open_volume_ml = 0
                 OR (
                     v_pool.open_inventory_value IS NOT NULL
                     AND v_pool.valuation_volume_ml =
                         v_pool.open_volume_ml
                 )
             )
                THEN v_pool.open_volume_ml + _remaining_ml
            ELSE NULL
        END,

        open_volume_ml =
            v_pool.open_volume_ml + _remaining_ml,

        containers_open =
            v_pool.containers_open + _container_count,

        updated_at = now()

    WHERE id = v_pool.id
      AND organization_id = v_org

    RETURNING * INTO v_pool;

    INSERT INTO public.stock_container_events (
        organization_id,
        branch_id,
        stock_item_id,
        location_id,
        event_type,
        containers_delta,
        volume_delta_ml,
        open_volume_after_ml,
        reason_code,
        reason,
        reference_type,
        reference_id,
        idempotency_key,
        performed_by,
        inventory_value_delta,
        open_inventory_value_after
    )
    VALUES (
        v_org,
        v_location.branch_id,
        _item,
        _location,
        'adjust',
        _container_count,
        _remaining_ml,
        v_pool.open_volume_ml,
        'opening_stock',
        btrim(_reason),
        'opening_stock',
        _reference,
        v_key,
        auth.uid(),
        _remaining_value,
        v_pool.open_inventory_value
    )
    RETURNING id INTO v_event;

    RETURN jsonb_build_object(
        'ok',true,
        'status','registered',
        'event_id',v_event,
        'registered_ml',_remaining_ml,
        'available_ml',v_pool.open_volume_ml,
        'open_inventory_value',
            v_pool.open_inventory_value,
        'valuation_status',
            CASE
                WHEN v_pool.open_inventory_value IS NULL
                    THEN 'unverified'
                ELSE 'verified'
            END,
        'sealed_stock_deducted',false
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_register_opening_container(
    uuid,uuid,numeric,integer,numeric,uuid,text
)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_register_opening_container(
    uuid,uuid,numeric,integer,numeric,uuid,text
)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;