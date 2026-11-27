BEGIN;

-- ============================================================
-- 1. Durable measured-volume transfer register.
--
-- Open volume is deliberately separated from sealed stock.
-- ============================================================

CREATE TABLE public.neo_open_volume_transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    stock_item_id uuid NOT NULL
        REFERENCES public.stock_items(id),

    from_location_id uuid NOT NULL
        REFERENCES public.stock_locations(id),

    to_location_id uuid NOT NULL
        REFERENCES public.stock_locations(id),

    volume_ml numeric NOT NULL,

    container_count integer NOT NULL,

    inventory_value numeric,

    status text NOT NULL DEFAULT 'in-transit',

    attempt_key uuid NOT NULL,

    reason text NOT NULL,

    dispatched_by uuid NOT NULL,

    dispatched_at timestamptz NOT NULL DEFAULT now(),

    received_by uuid,

    received_at timestamptz,

    cancelled_by uuid,

    cancelled_at timestamptz,

    cancellation_reason text,

    UNIQUE (organization_id,attempt_key),

    CHECK (
        volume_ml > 0
        AND volume_ml::text NOT IN (
            'NaN','Infinity','-Infinity'
        )
    ),

    CHECK (container_count > 0),

    CHECK (
        inventory_value IS NULL
        OR (
            inventory_value >= 0
            AND inventory_value::text NOT IN (
                'NaN','Infinity','-Infinity'
            )
        )
    ),

    CHECK (
        from_location_id <> to_location_id
    ),

    CHECK (
        status IN (
            'in-transit',
            'received',
            'cancelled'
        )
    )
);

ALTER TABLE public.neo_open_volume_transfers
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_open_volume_transfers
FROM PUBLIC,anon,authenticated;

CREATE INDEX neo_open_volume_transfer_scope_idx
ON public.neo_open_volume_transfers (
    organization_id,
    branch_id,
    status,
    dispatched_at DESC
);


-- ============================================================
-- 2. Shared transfer authorization.
-- ============================================================

CREATE FUNCTION public.neo_assert_open_volume_transfer_access(
    _branch uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
BEGIN

    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.neo_can_transfer_stock() IS NOT TRUE
       OR _branch IS NULL
       OR public.neo_branch_in_scope(_branch) IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Open-stock transfer is outside your authorised access'
            USING ERRCODE = '42501';
    END IF;

    RETURN v_org;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_assert_open_volume_transfer_access(uuid)
FROM PUBLIC,anon,authenticated;


-- ============================================================
-- 3. Dispatch measured open stock.
--
-- Source volume and its proportional carrying value are
-- removed together. Destination stock is not yet credited.
-- ============================================================

CREATE FUNCTION public.neo_open_volume_transfer_dispatch(
    _branch uuid,
    _item uuid,
    _from uuid,
    _to uuid,
    _ml numeric,
    _containers integer,
    _attempt uuid,
    _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid;
    v_item public.stock_items;
    v_pool public.stock_open_containers;
    v_transfer public.neo_open_volume_transfers;
    v_value numeric;
BEGIN

    v_org :=
        public.neo_assert_open_volume_transfer_access(
            _branch
        );

    IF _attempt IS NULL
       OR _item IS NULL
       OR _from IS NULL
       OR _to IS NULL
       OR _from = _to
       OR _ml IS NULL
       OR _ml <= 0
       OR _ml::text IN (
           'NaN','Infinity','-Infinity'
       )
       OR _containers IS NULL
       OR _containers <= 0
       OR length(btrim(coalesce(_reason,''))) < 3
    THEN
        RAISE EXCEPTION
            'Invalid measured-volume transfer details';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            v_org::text ||
            ':open-transfer:' ||
            _attempt::text,
            0
        )
    );

    SELECT * INTO v_transfer
    FROM public.neo_open_volume_transfers
    WHERE organization_id = v_org
      AND attempt_key = _attempt;

    IF FOUND THEN

        IF v_transfer.branch_id
               IS DISTINCT FROM _branch
           OR v_transfer.stock_item_id
               IS DISTINCT FROM _item
           OR v_transfer.from_location_id
               IS DISTINCT FROM _from
           OR v_transfer.to_location_id
               IS DISTINCT FROM _to
           OR v_transfer.volume_ml
               IS DISTINCT FROM _ml
           OR v_transfer.container_count
               IS DISTINCT FROM _containers
           OR v_transfer.reason
               IS DISTINCT FROM btrim(_reason)
        THEN
            RAISE EXCEPTION
                'Transfer attempt belongs to different work';
        END IF;

        RETURN jsonb_build_object(
            'ok',true,
            'transfer_id',v_transfer.id,
            'status',v_transfer.status,
            'replayed',true
        );

    END IF;

    SELECT * INTO v_item
    FROM public.stock_items
    WHERE id = _item
      AND organization_id = v_org
      AND active IS TRUE
      AND (
          branch_id IS NULL
          OR branch_id = _branch
      );

    IF NOT FOUND
       OR v_item.may_open_for_pours IS NOT TRUE
       OR coalesce(v_item.tracking_method,'') NOT IN ('volume','both')
       OR v_item.container_volume_ml IS NULL
       OR v_item.container_volume_ml <= 0
       OR v_item.container_volume_ml::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
            'Item is not configured for open-volume transfers';
    END IF;

    IF _ml >
       v_item.container_volume_ml * _containers
    THEN
        RAISE EXCEPTION
            'Transfer volume exceeds container capacity';
    END IF;

    IF (
        SELECT count(*)
        FROM public.stock_locations
        WHERE organization_id = v_org
          AND branch_id = _branch
          AND active IS TRUE
          AND id IN (_from,_to)
    ) <> 2 THEN

        RAISE EXCEPTION
            'Both stores must be active within the same property';

    END IF;

    SELECT * INTO v_pool
    FROM public.stock_open_containers
    WHERE organization_id = v_org
      AND branch_id = _branch
      AND stock_item_id = _item
      AND location_id = _from
    FOR UPDATE;

    IF NOT FOUND
       OR v_pool.open_volume_ml < _ml
       OR v_pool.containers_open < _containers
    THEN
        RAISE EXCEPTION
            'Insufficient available open stock';
    END IF;

    -- Do not leave positive volume without a container,
    -- or leave volume exceeding remaining container capacity.

    IF v_pool.open_volume_ml - _ml >
       (
           v_pool.containers_open - _containers
       ) * v_item.container_volume_ml
    THEN
        RAISE EXCEPTION
            'Remaining source volume exceeds remaining container capacity';
    END IF;

    IF v_pool.open_volume_ml = _ml
       AND v_pool.containers_open <> _containers
    THEN
        RAISE EXCEPTION
            'Moving all remaining liquid must account for every remaining open container';
    END IF;

    -- Only carry forward a valuation supported by the
    -- complete measured source balance.

    IF v_pool.open_inventory_value IS NOT NULL
       AND v_pool.valuation_volume_ml =
           v_pool.open_volume_ml
    THEN

        IF _ml = v_pool.open_volume_ml THEN
            v_value := v_pool.open_inventory_value;
        ELSE
            v_value :=
                v_pool.open_inventory_value
                * _ml
                / v_pool.open_volume_ml;
        END IF;

    ELSE
        v_value := NULL;
    END IF;

    INSERT INTO public.neo_open_volume_transfers (
        organization_id,
        branch_id,
        stock_item_id,
        from_location_id,
        to_location_id,
        volume_ml,
        container_count,
        inventory_value,
        attempt_key,
        reason,
        dispatched_by
    )
    VALUES (
        v_org,
        _branch,
        _item,
        _from,
        _to,
        _ml,
        _containers,
        v_value,
        _attempt,
        btrim(_reason),
        auth.uid()
    )
    RETURNING * INTO v_transfer;

    UPDATE public.stock_open_containers
    SET
        open_volume_ml =
            v_pool.open_volume_ml - _ml,

        containers_open =
            v_pool.containers_open - _containers,

        open_inventory_value = CASE

            WHEN v_pool.open_volume_ml = _ml
                THEN 0

            WHEN v_value IS NOT NULL
                THEN v_pool.open_inventory_value
                     - v_value

            ELSE NULL

        END,

        valuation_volume_ml = CASE

            WHEN v_pool.open_volume_ml = _ml
                THEN 0

            WHEN v_value IS NOT NULL
                THEN v_pool.open_volume_ml - _ml

            ELSE NULL

        END,

        updated_at = now()

    WHERE id = v_pool.id

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
        _branch,
        _item,
        _from,
        'adjust',
        -_containers,
        -_ml,
        v_pool.open_volume_ml,
        'transfer',
        btrim(_reason),
        'open_volume_transfer',
        v_transfer.id,
        'open-transfer-out:' || v_transfer.id::text,
        auth.uid(),
        -v_value,
        v_pool.open_inventory_value
    );

    RETURN jsonb_build_object(
        'ok',true,
        'transfer_id',v_transfer.id,
        'status','in-transit',
        'volume_ml',_ml,
        'inventory_value',v_value,
        'replayed',false
    );

END;
$function$;


-- ============================================================
-- 4. Receive or cancel an in-transit transfer.
--
-- Receipt credits the destination.
-- Cancellation restores the original source.
-- Neither action touches sealed stock.
-- ============================================================

CREATE FUNCTION public.neo_open_volume_transfer_finish(
    _transfer uuid,
    _action text,
    _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    t public.neo_open_volume_transfers;
    p public.stock_open_containers;
    v_location uuid;
    v_status text;
    v_event_key text;
BEGIN

    IF _action IS NULL
       OR _action NOT IN ('receive','cancel')
    THEN
        RAISE EXCEPTION 'Invalid transfer action';
    END IF;

    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO t
    FROM public.neo_open_volume_transfers
    WHERE id = _transfer
      AND organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer not found';
    END IF;

    PERFORM public.neo_assert_open_volume_transfer_access(
        t.branch_id
    );

    v_status := CASE
        WHEN _action = 'receive' THEN 'received'
        ELSE 'cancelled'
    END;

    IF t.status = v_status THEN
        RETURN jsonb_build_object(
            'ok',true,
            'transfer_id',t.id,
            'status',t.status,
            'replayed',true
        );
    END IF;

    IF t.status <> 'in-transit' THEN
        RAISE EXCEPTION
            'Transfer already has a different final decision';
    END IF;

    IF _action = 'receive'
       AND t.dispatched_by = auth.uid()
       AND public.is_org_admin() IS NOT TRUE
    THEN
        RAISE EXCEPTION
            'Receipt must be confirmed by another authorised employee'
            USING ERRCODE = '42501';
    END IF;

    IF _action = 'cancel'
       AND length(btrim(coalesce(_reason,''))) < 3
    THEN
        RAISE EXCEPTION
            'Enter a transfer cancellation reason';
    END IF;

    v_location := CASE
        WHEN _action = 'receive'
            THEN t.to_location_id
        ELSE t.from_location_id
    END;

    PERFORM 1
    FROM public.stock_locations
    WHERE id = v_location
      AND organization_id = v_org
      AND branch_id = t.branch_id
      AND active IS TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Target stock location requires reconciliation';
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
        t.branch_id,
        t.stock_item_id,
        v_location,
        0,0,0,0
    )
    ON CONFLICT (stock_item_id,location_id)
    DO NOTHING;

    SELECT * INTO STRICT p
    FROM public.stock_open_containers
    WHERE organization_id = v_org
      AND branch_id = t.branch_id
      AND stock_item_id = t.stock_item_id
      AND location_id = v_location
    FOR UPDATE;

    UPDATE public.stock_open_containers
    SET
        open_volume_ml =
            p.open_volume_ml + t.volume_ml,

        containers_open =
            p.containers_open + t.container_count,

        open_inventory_value = CASE

            WHEN t.inventory_value IS NULL
                THEN NULL

            WHEN p.open_volume_ml = 0
                THEN t.inventory_value

            WHEN p.open_inventory_value IS NOT NULL
             AND p.valuation_volume_ml = p.open_volume_ml

                THEN p.open_inventory_value
                     + t.inventory_value

            ELSE NULL

        END,

        valuation_volume_ml = CASE

            WHEN t.inventory_value IS NOT NULL
             AND (
                 p.open_volume_ml = 0
                 OR (
                     p.open_inventory_value IS NOT NULL
                     AND p.valuation_volume_ml =
                         p.open_volume_ml
                 )
             )

                THEN p.open_volume_ml + t.volume_ml

            ELSE NULL

        END,

        updated_at = now()

    WHERE id = p.id

    RETURNING * INTO p;

    v_event_key :=
        'open-transfer-' ||
        _action || ':' || t.id::text;

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
        t.branch_id,
        t.stock_item_id,
        v_location,
        'adjust',
        t.container_count,
        t.volume_ml,
        p.open_volume_ml,
        'transfer',
        coalesce(nullif(btrim(_reason),''),t.reason),
        'open_volume_transfer',
        t.id,
        v_event_key,
        auth.uid(),
        t.inventory_value,
        p.open_inventory_value
    );

    UPDATE public.neo_open_volume_transfers
    SET
        status = v_status,

        received_by = CASE
            WHEN _action = 'receive' THEN auth.uid()
            ELSE received_by
        END,

        received_at = CASE
            WHEN _action = 'receive' THEN now()
            ELSE received_at
        END,

        cancelled_by = CASE
            WHEN _action = 'cancel' THEN auth.uid()
            ELSE cancelled_by
        END,

        cancelled_at = CASE
            WHEN _action = 'cancel' THEN now()
            ELSE cancelled_at
        END,

        cancellation_reason = CASE
            WHEN _action = 'cancel' THEN btrim(_reason)
            ELSE cancellation_reason
        END

    WHERE id = t.id;

    RETURN jsonb_build_object(
        'ok',true,
        'transfer_id',t.id,
        'status',v_status,
        'volume_ml',t.volume_ml,
        'inventory_value',t.inventory_value,
        'replayed',false
    );

END;
$function$;


-- ============================================================
-- 5. Scoped transfer register.
-- ============================================================

CREATE FUNCTION public.neo_open_volume_transfer_list(
    _branch uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog,public
AS $function$
DECLARE
    v_org uuid;
BEGIN

    v_org :=
        public.neo_assert_open_volume_transfer_access(
            _branch
        );

    RETURN (
        SELECT coalesce(
            jsonb_agg(
                to_jsonb(t) ||
                jsonb_build_object(
                    'item_name',si.name,
                    'source_name',sl1.name,
                    'destination_name',sl2.name
                )
                ORDER BY t.dispatched_at DESC
            ),
            '[]'::jsonb
        )

        FROM public.neo_open_volume_transfers t

        JOIN public.stock_items si
          ON si.id = t.stock_item_id
         AND si.organization_id = v_org

        JOIN public.stock_locations sl1
          ON sl1.id = t.from_location_id
         AND sl1.organization_id = v_org

        JOIN public.stock_locations sl2
          ON sl2.id = t.to_location_id
         AND sl2.organization_id = v_org

        WHERE t.organization_id = v_org
          AND t.branch_id = _branch
    );

END;
$function$;


-- ============================================================
-- 6. Restrict access to controlled RPCs.
-- ============================================================

REVOKE ALL ON FUNCTION
public.neo_open_volume_transfer_dispatch(
    uuid,uuid,uuid,uuid,numeric,integer,uuid,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_open_volume_transfer_finish(
    uuid,text,text
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_open_volume_transfer_list(uuid)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_open_volume_transfer_dispatch(
    uuid,uuid,uuid,uuid,numeric,integer,uuid,text
)
TO authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_open_volume_transfer_finish(
    uuid,text,text
)
TO authenticated;

GRANT EXECUTE ON FUNCTION
public.neo_open_volume_transfer_list(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;