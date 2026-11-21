-- E1C-1: Transactional quotation line-item pricing.
-- Code migration only. Requires separate controlled database installation.
--
-- Only draft quotations can be repriced.
-- Prices are derived from line items, not trusted from client totals.

CREATE OR REPLACE FUNCTION public.neo_event_quotation_price(
    _quotation uuid,
    _items jsonb,
    _discount numeric DEFAULT 0,
    _tax_rate numeric DEFAULT 0,
    _service_rate numeric DEFAULT 0,
    _deposit_percent numeric DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_q public.event_quotations%ROWTYPE;
    v_item jsonb;
    v_description text;
    v_category text;
    v_unit text;
    v_quantity numeric;
    v_price numeric;
    v_cost numeric;
    v_line numeric;
    v_subtotal numeric := 0;
    v_taxable numeric := 0;
    v_discount numeric;
    v_tax numeric;
    v_service numeric;
    v_total numeric;
    v_deposit numeric;
    v_balance numeric;
    v_count integer := 0;
    v_sort integer := 0;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'An authenticated workspace is required.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_permission('events', 'quotations', 'edit') THEN
        RAISE EXCEPTION 'Quotation editing permission is required.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_q
      FROM public.event_quotations
     WHERE id = _quotation
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quotation not found in this workspace.'
            USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.neo_branch_in_scope(v_q.branch_id) THEN
        RAISE EXCEPTION 'Quotation property is outside your access scope.'
            USING ERRCODE = '42501';
    END IF;

    IF v_q.status <> 'draft' THEN
        RAISE EXCEPTION 'Only draft quotations can be edited. Create a revision first.'
            USING ERRCODE = '22023';
    END IF;

    IF _items IS NULL
       OR jsonb_typeof(_items) <> 'array'
       OR jsonb_array_length(_items) = 0 THEN
        RAISE EXCEPTION 'Provide at least one quotation line item.'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(_items) > 200 THEN
        RAISE EXCEPTION 'A quotation cannot contain more than 200 lines.'
            USING ERRCODE = '22023';
    END IF;

    IF _discount IS NULL OR _discount < 0
       OR _tax_rate IS NULL OR _tax_rate < 0 OR _tax_rate > 100
       OR _service_rate IS NULL OR _service_rate < 0 OR _service_rate > 100
       OR _deposit_percent IS NULL
       OR _deposit_percent < 0 OR _deposit_percent > 100 THEN
        RAISE EXCEPTION 'Invalid discount, tax, service charge or deposit percentage.'
            USING ERRCODE = '22023';
    END IF;

    -- Existing lines belong to this draft only.
    -- Any error below rolls back the entire operation.
    DELETE FROM public.event_quotation_items
     WHERE quotation_id = _quotation
       AND organization_id = v_org;

    FOR v_item IN
        SELECT value FROM jsonb_array_elements(_items)
    LOOP
        IF jsonb_typeof(v_item) <> 'object' THEN
            RAISE EXCEPTION 'Every quotation line must be an object.'
                USING ERRCODE = '22023';
        END IF;

        v_description := nullif(btrim(coalesce(v_item->>'description', '')), '');
        v_category := coalesce(nullif(btrim(v_item->>'category'), ''), 'other');
        v_unit := coalesce(nullif(btrim(v_item->>'unit'), ''), 'unit');

        v_quantity := nullif(v_item->>'quantity', '')::numeric;
        v_price := nullif(v_item->>'unit_price', '')::numeric;
        v_cost := coalesce(nullif(v_item->>'unit_cost', '')::numeric, 0);

        IF v_description IS NULL
           OR v_quantity IS NULL OR v_quantity <= 0
           OR v_price IS NULL OR v_price < 0
           OR v_cost < 0 THEN
            RAISE EXCEPTION 'Invalid description, quantity or price on quotation line %.',
                v_sort + 1
                USING ERRCODE = '22023';
        END IF;

        v_line := round(v_quantity * v_price, 2);
        v_sort := v_sort + 1;

        INSERT INTO public.event_quotation_items (
            organization_id,
            quotation_id,
            category,
            description,
            quantity,
            unit,
            unit_price,
            line_total,
            taxable,
            unit_cost,
            sort_order
        )
        VALUES (
            v_org,
            _quotation,
            v_category,
            v_description,
            v_quantity,
            v_unit,
            v_price,
            v_line,
            coalesce((v_item->>'taxable')::boolean, true),
            v_cost,
            v_sort
        );

        v_subtotal := v_subtotal + v_line;

        IF coalesce((v_item->>'taxable')::boolean, true) THEN
            v_taxable := v_taxable + v_line;
        END IF;

        v_count := v_count + 1;
    END LOOP;

    IF _discount > v_subtotal THEN
        RAISE EXCEPTION 'Discount cannot exceed the quotation subtotal.'
            USING ERRCODE = '22023';
    END IF;

    v_discount := round(_discount, 2);

    -- Allocate the discount proportionately across taxable and non-taxable lines.
    IF v_subtotal > 0 THEN
        v_taxable := greatest(
            0,
            v_taxable - (v_discount * v_taxable / v_subtotal)
        );
    END IF;

    v_tax := round(v_taxable * _tax_rate / 100, 2);
    v_service := round((v_subtotal - v_discount) * _service_rate / 100, 2);

    v_total := round(
        v_subtotal - v_discount + v_service + v_tax,
        2
    );

    v_deposit := round(v_total * _deposit_percent / 100, 2);
    v_balance := v_total - v_deposit;

    UPDATE public.event_quotations
       SET subtotal = v_subtotal,
           discount_amount = v_discount,
           service_charge_rate = _service_rate,
           service_charge_amount = v_service,
           tax_rate = _tax_rate,
           tax_amount = v_tax,
           grand_total = v_total,
           deposit_percent = _deposit_percent,
           deposit_amount = v_deposit,
           balance_due = v_balance,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = _quotation
       AND organization_id = v_org;

    RETURN jsonb_build_object(
        'quotation_id', _quotation,
        'line_count', v_count,
        'subtotal', v_subtotal,
        'discount', v_discount,
        'service_charge', v_service,
        'tax', v_tax,
        'grand_total', v_total,
        'deposit_required', v_deposit,
        'post_deposit_remainder', v_balance,
        'status', 'draft'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_event_quotation_price(
    uuid, jsonb, numeric, numeric, numeric, numeric
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.neo_event_quotation_price(
    uuid, jsonb, numeric, numeric, numeric, numeric
) TO authenticated;
