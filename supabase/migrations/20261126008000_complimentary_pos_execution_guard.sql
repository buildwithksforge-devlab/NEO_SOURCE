BEGIN;

ALTER TABLE public.complimentary_register
ADD COLUMN IF NOT EXISTS menu_item_id uuid
REFERENCES public.menu_items(id)
ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION
public.neo_complimentary_menu_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    menu public.menu_items;
    menu_data jsonb;
BEGIN

    IF NEW.menu_item_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT *
    INTO menu
    FROM public.menu_items
    WHERE id = NEW.menu_item_id
      AND organization_id = NEW.organization_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Selected menu item is outside the complimentary workspace';
    END IF;

    menu_data := to_jsonb(menu);

    IF public.neo_record_operationally_enabled(
        menu_data
    ) IS NOT TRUE THEN
        RAISE EXCEPTION
            'Inactive or archived menu items cannot be approved';
    END IF;

    IF nullif(menu_data->>'branch_id','') IS NOT NULL
       AND (menu_data->>'branch_id')::uuid
           IS DISTINCT FROM NEW.branch_id
    THEN
        RAISE EXCEPTION
            'Selected menu item belongs to another property';
    END IF;

    IF NEW.quantity IS NULL
       OR NEW.quantity <= 0
       OR NEW.quantity::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
            'Complimentary quantity must be finite and positive';
    END IF;

    IF NEW.pricing_type = 'complimentary'
       AND NEW.amount_charged IS DISTINCT FROM 0
    THEN
        RAISE EXCEPTION
            'Complimentary items cannot carry a customer charge';
    END IF;

    RETURN NEW;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_menu_binding_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_complimentary_menu_binding_guard
ON public.complimentary_register;

CREATE TRIGGER
trg_neo_complimentary_menu_binding_guard
BEFORE INSERT OR UPDATE OF
menu_item_id,quantity,amount_charged,pricing_type
ON public.complimentary_register
FOR EACH ROW
EXECUTE FUNCTION
public.neo_complimentary_menu_binding_guard();



CREATE TABLE IF NOT EXISTS
public.neo_complimentary_execution_evidence (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,

    branch_id uuid NOT NULL,

    approval_id uuid NOT NULL UNIQUE,

    order_id uuid NOT NULL,

    order_item_id uuid NOT NULL UNIQUE,

    menu_item_id uuid NOT NULL,

    quantity numeric NOT NULL,

    executed_by uuid NOT NULL,

    approved_by uuid NOT NULL,

    executed_at timestamptz NOT NULL DEFAULT now(),

    approval_snapshot jsonb NOT NULL,

    CONSTRAINT neo_complimentary_execution_quantity_valid
    CHECK (
        quantity > 0
        AND quantity::text NOT IN (
            'NaN','Infinity','-Infinity'
        )
    )
);

ALTER TABLE public.neo_complimentary_execution_evidence
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
public.neo_complimentary_execution_evidence
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION
public.neo_complimentary_execution_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    RAISE EXCEPTION
        'Complimentary execution evidence cannot be modified or deleted';

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_execution_immutable()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_complimentary_execution_immutable
ON public.neo_complimentary_execution_evidence;

CREATE TRIGGER
trg_neo_complimentary_execution_immutable
BEFORE UPDATE OR DELETE
ON public.neo_complimentary_execution_evidence
FOR EACH ROW
EXECUTE FUNCTION
public.neo_complimentary_execution_immutable();


CREATE OR REPLACE FUNCTION
public.neo_complimentary_order_binding_valid(
    _approval jsonb,
    _order jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO pg_catalog,public

AS $function$

BEGIN

    IF _approval IS NULL

       OR _order IS NULL

       OR nullif(
           _approval->>'organization_id',''
       ) IS NULL

       OR nullif(
           _approval->>'branch_id',''
       ) IS NULL

       OR nullif(
           _order->>'id',''
       ) IS NULL

       OR _approval->>'organization_id'
          IS DISTINCT FROM
          _order->>'organization_id'

       OR _approval->>'branch_id'
          IS DISTINCT FROM
          _order->>'branch_id'

    THEN

        RETURN false;

    END IF;

    -- An executable approval must identify
    -- the specific original POS order.

    IF coalesce(
        _approval->>'reference_type',''
    ) NOT IN (
        'pos_order',
        'pos-order'
    )

    OR nullif(
        _approval->>'reference_id',''
    ) IS NULL

    OR _approval->>'reference_id'
       IS DISTINCT FROM
       _order->>'id'

    THEN

        RETURN false;

    END IF;

    -- Where a customer was identified during approval,
    -- the original order must belong to that customer.

    IF nullif(
        _approval->>'customer_id',''
    ) IS NOT NULL

    AND _approval->>'customer_id'
        IS DISTINCT FROM
        _order->>'customer_id'

    THEN

        RETURN false;

    END IF;

    -- Staff benefits require a separate verifiable
    -- beneficiary-to-order association.
    -- Never infer the beneficiary from a waiter or cashier.

    IF nullif(
        _approval->>'employee_id',''
    ) IS NOT NULL

    THEN

        RETURN false;

    END IF;

    RETURN true;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_order_binding_valid(jsonb,jsonb)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION
public.neo_pos_complimentary_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    approval public.complimentary_register;
    parent_order public.pos_orders;
    approval_data jsonb;
    actor uuid := auth.uid();
    org uuid := public.current_org_id();
BEGIN

    IF TG_OP = 'UPDATE' THEN

        IF OLD.complimentary_id IS NOT NULL
           AND NEW.complimentary_id
               IS DISTINCT FROM OLD.complimentary_id
        THEN
            RAISE EXCEPTION
                'Existing complimentary approval evidence cannot be replaced';
        END IF;

        IF OLD.complimentary_id IS NOT NULL
           AND NEW.complimentary_id = OLD.complimentary_id
        THEN

            IF (
                to_jsonb(NEW)->'quantity'
            ) IS DISTINCT FROM (
                to_jsonb(OLD)->'quantity'
            )

            OR (
                to_jsonb(NEW)->'menu_item_id'
            ) IS DISTINCT FROM (
                to_jsonb(OLD)->'menu_item_id'
            )

            OR NEW.order_id IS DISTINCT FROM OLD.order_id

            OR NEW.organization_id
               IS DISTINCT FROM OLD.organization_id

            OR NEW.pricing_type
               IS DISTINCT FROM OLD.pricing_type

            OR NEW.normal_selling_price
               IS DISTINCT FROM OLD.normal_selling_price

            OR NEW.pricing_approved_by
               IS DISTINCT FROM OLD.pricing_approved_by

            OR NEW.pricing_approved_at
               IS DISTINCT FROM OLD.pricing_approved_at

            OR NEW.pricing_reason
               IS DISTINCT FROM OLD.pricing_reason

            OR NEW.unit_price
               IS DISTINCT FROM OLD.unit_price

            OR NEW.discount_amount
               IS DISTINCT FROM OLD.discount_amount

            OR NEW.modifier_total
               IS DISTINCT FROM OLD.modifier_total

            THEN

                RAISE EXCEPTION
                    'Approved complimentary item identity and quantity cannot be changed';

            END IF;

            RETURN NEW;

        END IF;

    END IF;

    IF NEW.complimentary_id IS NULL THEN

        IF NEW.pricing_type = 'complimentary' THEN

            RAISE EXCEPTION
                'Complimentary pricing requires approved execution evidence';

        END IF;

        RETURN NEW;

    END IF;

    IF actor IS NULL
       OR org IS NULL
       OR NEW.organization_id IS DISTINCT FROM org
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
    THEN

        RAISE EXCEPTION
            'Authorized workspace access is required'
            USING ERRCODE = '42501';

    END IF;

    IF public.has_permission(
        'pos','complimentary.execute'
    ) IS NOT TRUE

    AND public.is_org_admin() IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Complimentary execution authority is required'
            USING ERRCODE = '42501';

    END IF;

    SELECT *
    INTO parent_order

    FROM public.pos_orders

    WHERE id = NEW.order_id
      AND organization_id = org

    FOR UPDATE;

    IF NOT FOUND

       OR parent_order.branch_id IS NULL

       OR public.neo_branch_in_scope(
           parent_order.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'POS order is outside the authorized property'
            USING ERRCODE = '42501';

    END IF;

    SELECT *
    INTO approval

    FROM public.complimentary_register

    WHERE id = NEW.complimentary_id
      AND organization_id = org

    FOR UPDATE;

    IF NOT FOUND

       OR approval.branch_id
          IS DISTINCT FROM parent_order.branch_id

       OR approval.status
          IS DISTINCT FROM 'approved'

       OR approval.approved_by IS NULL

       OR approval.approved_at IS NULL

       OR approval.requested_by IS NULL

       OR approval.approved_by
          IS NOT DISTINCT FROM approval.requested_by

    THEN

        RAISE EXCEPTION
            'A valid independent complimentary approval is required'
            USING ERRCODE = '42501';

    END IF;

    -- COMPLIMENTARY_ATOMIC_ENTRY_V1

    IF current_setting(
        'neo.complimentary_execution_approval',
        true
    ) IS DISTINCT FROM NEW.complimentary_id::text
    THEN

        RAISE EXCEPTION
            'Use the controlled complimentary execution function';

    END IF;

    approval_data := to_jsonb(approval);

    IF public.neo_complimentary_order_binding_valid(
        approval_data,
        to_jsonb(parent_order)
    ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Complimentary approval does not belong to this order or beneficiary';

    END IF;

    IF approval.amount_charged IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION
            'Complimentary approval must authorize zero customer charge';
    END IF;

    IF approval.normal_selling_price IS NULL
       OR approval.normal_selling_price < 0
       OR approval.normal_selling_price::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN
        RAISE EXCEPTION
            'Approved normal selling price is invalid';
    END IF;

    IF NEW.status IS DISTINCT FROM 'draft'
       OR NEW.sent_at IS NOT NULL
    THEN
        RAISE EXCEPTION
            'Complimentary approval must be applied before production dispatch';
    END IF;

    IF NEW.unit_price IS DISTINCT FROM
        approval.normal_selling_price
    THEN

        RAISE EXCEPTION
            'Complimentary execution price differs from approved price';

    END IF;

    IF NEW.discount_amount IS DISTINCT FROM
        round(approval.normal_selling_price * approval.quantity,2)
    THEN

        RAISE EXCEPTION
            'Complimentary discount differs from approved value';

    END IF;

    IF coalesce(NEW.modifier_total,0) <> 0 THEN

        RAISE EXCEPTION
            'Unapproved modifiers cannot receive complimentary pricing';

    END IF;

    NEW.pricing_type := 'complimentary';

    NEW.normal_selling_price :=
        approval.normal_selling_price;

    NEW.pricing_reason := approval.reason;

    NEW.pricing_approved_by := approval.approved_by;

    NEW.pricing_approved_at := approval.approved_at;


    IF approval_data->>'pricing_type'
       IS DISTINCT FROM 'complimentary'
    THEN

        RAISE EXCEPTION
            'This approval is not for complimentary pricing';

    END IF;

    -- Prevent an approval being attached to an unrelated
    -- menu item when the original approval has no
    -- verifiable menu identity.

    IF nullif(
        approval_data->>'menu_item_id',''
    ) IS NULL

    OR approval_data->>'menu_item_id'
       IS DISTINCT FROM
       to_jsonb(NEW)->>'menu_item_id'

    THEN

        RAISE EXCEPTION
            'Complimentary approval requires the exact approved menu item';

    END IF;

    IF coalesce(
        (approval_data->>'quantity')::numeric,0
    ) <= 0

    OR (
        approval_data->>'quantity'
    )::numeric IS DISTINCT FROM NEW.quantity

    THEN

        RAISE EXCEPTION
            'POS quantity must match the approved complimentary quantity';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.pos_order_items i

        WHERE i.complimentary_id =
              NEW.complimentary_id

          AND i.id IS DISTINCT FROM NEW.id

    ) THEN

        RAISE EXCEPTION
            'This complimentary approval has already been used';

    END IF;


    IF NEW.quantity IS NULL

       OR NEW.quantity <= 0

       OR NEW.quantity::text IN (
           'NaN','Infinity','-Infinity'
       )

    THEN

        RAISE EXCEPTION
            'Complimentary execution requires a finite positive quantity';

    END IF;

    IF EXISTS (

        SELECT 1

        FROM public.neo_complimentary_execution_evidence e

        WHERE e.approval_id = NEW.complimentary_id

    ) THEN

        RAISE EXCEPTION
            'This complimentary approval has already been consumed';

    END IF;

    INSERT INTO public.neo_complimentary_execution_evidence (

        organization_id,

        branch_id,

        approval_id,

        order_id,

        order_item_id,

        menu_item_id,

        quantity,

        executed_by,

        approved_by,

        approval_snapshot

    ) VALUES (

        org,

        parent_order.branch_id,

        NEW.complimentary_id,

        NEW.order_id,

        NEW.id,

        (to_jsonb(NEW)->>'menu_item_id')::uuid,

        NEW.quantity,

        actor,

        approval.approved_by,

        to_jsonb(approval)

    );

    RETURN NEW;


END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_complimentary_item_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_pos_complimentary_item_guard
ON public.pos_order_items;

CREATE TRIGGER
trg_neo_pos_complimentary_item_guard
BEFORE INSERT OR UPDATE
ON public.pos_order_items
FOR EACH ROW
EXECUTE FUNCTION
public.neo_pos_complimentary_item_guard();


CREATE OR REPLACE FUNCTION
public.neo_pos_execute_complimentary(
    _order uuid,
    _item uuid,
    _approval uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    org uuid := public.current_org_id();
    actor uuid := auth.uid();

    o public.pos_orders;
    i public.pos_order_items;
    a public.complimentary_register;
    m public.menu_items;

    order_data jsonb;
    evidence public.neo_complimentary_execution_evidence;

BEGIN

    IF actor IS NULL
       OR org IS NULL
       OR public.current_access_scope() IS NULL
       OR public.current_access_scope() = 'technical'
    THEN

        RAISE EXCEPTION
            'Authorized workspace access is required'
            USING ERRCODE = '42501';

    END IF;

    IF public.has_permission(
        'pos','complimentary.execute'
    ) IS NOT TRUE

    AND public.is_org_admin() IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Complimentary execution authority is required'
            USING ERRCODE = '42501';

    END IF;

    SELECT *
    INTO o
    FROM public.pos_orders
    WHERE id = _order
      AND organization_id = org
    FOR UPDATE;

    IF NOT FOUND
       OR o.branch_id IS NULL
       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE
    THEN

        RAISE EXCEPTION
            'POS order is outside the authorized property';

    END IF;

    SELECT *
    INTO i
    FROM public.pos_order_items
    WHERE id = _item
      AND order_id = o.id
      AND organization_id = org
    FOR UPDATE;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Original POS item is unavailable';

    END IF;

    SELECT *
    INTO evidence
    FROM public.neo_complimentary_execution_evidence
    WHERE approval_id = _approval;

    IF FOUND THEN

        IF evidence.organization_id = org
           AND evidence.order_id = o.id
           AND evidence.order_item_id = i.id
           AND i.complimentary_id = _approval
        THEN

            RETURN jsonb_build_object(
                'ok',true,
                'reused',true,
                'order_id',o.id,
                'order_item_id',i.id,
                'approval_id',_approval
            );

        END IF;

        RAISE EXCEPTION
            'Complimentary approval has already been consumed';

    END IF;

    order_data := to_jsonb(o);

    -- Conservative execution boundary:
    -- only an unpaid draft item on an editable order.

    IF order_data->>'status' IS NULL

       OR order_data->>'status' NOT IN (
           'draft','sent','accepted',
           'in-preparation','partially-ready','ready',
           'partially-served','served','awaiting-payment'
       )

    THEN

        RAISE EXCEPTION
            'Order is not eligible for complimentary execution';

    END IF;

    IF order_data->>'payment_status'
       IS DISTINCT FROM 'unpaid'

    THEN

        RAISE EXCEPTION
            'Orders with existing settlement cannot be repriced';

    END IF;

    IF i.status IS DISTINCT FROM 'draft'
       OR i.sent_at IS NOT NULL
       OR i.complimentary_id IS NOT NULL
    THEN

        RAISE EXCEPTION
            'Only an unexecuted draft item can receive approval';

    END IF;

    SELECT *
    INTO a
    FROM public.complimentary_register
    WHERE id = _approval
      AND organization_id = org
      AND branch_id = o.branch_id
    FOR UPDATE;

    IF NOT FOUND
       OR a.status IS DISTINCT FROM 'approved'
       OR a.pricing_type IS DISTINCT FROM 'complimentary'
       OR a.amount_charged IS DISTINCT FROM 0
       OR a.menu_item_id IS DISTINCT FROM i.menu_item_id
       OR a.quantity IS DISTINCT FROM i.quantity
       OR a.approved_by IS NULL
       OR a.approved_at IS NULL
       OR a.requested_by IS NULL
       OR a.approved_by = a.requested_by
    THEN

        RAISE EXCEPTION
            'Approval does not authorize this POS item';

    END IF;

    IF public.neo_complimentary_order_binding_valid(
        to_jsonb(a),
        to_jsonb(o)
    ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Complimentary approval is not bound to this order or beneficiary';

    END IF;

    SELECT *
    INTO m
    FROM public.menu_items
    WHERE id = i.menu_item_id
      AND organization_id = org
    FOR SHARE;

    IF NOT FOUND
       OR public.neo_record_operationally_enabled(
           to_jsonb(m)
       ) IS NOT TRUE
    THEN

        RAISE EXCEPTION
            'Menu item is inactive or unavailable';

    END IF;

    -- Paid extras require separate approval.
    -- Do not silently give away unapproved modifiers.

    IF coalesce(i.modifier_total,0) <> 0
       OR EXISTS (
           SELECT 1
           FROM public.pos_order_item_modifiers x
           WHERE x.organization_id = org
             AND x.order_item_id = i.id
             AND coalesce(x.extra_charge,0) <> 0
       )
    THEN

        RAISE EXCEPTION
            'Paid modifiers require separate complimentary approval';

    END IF;

    -- Protect against an approval for a lower-value item
    -- being applied after its selling price changes.

    IF i.unit_price IS DISTINCT FROM a.normal_selling_price
       OR i.unit_price < 0
       OR i.unit_price::text IN (
           'NaN','Infinity','-Infinity'
       )
    THEN

        RAISE EXCEPTION
            'Current POS price differs from approved selling price';

    END IF;

    -- The existing BEFORE trigger validates the approval
    -- and records permanent execution evidence atomically.

    PERFORM set_config(
        'neo.complimentary_execution_approval',
        a.id::text,
        true
    );

    UPDATE public.pos_order_items

    SET complimentary_id = a.id,

        discount_amount = round(i.unit_price * i.quantity,2),

        -- Explicitly provide the approved financial outcome.
        -- Existing canonical tax triggers retain final authority
        -- over tax-profile calculation and saved tax evidence.

        line_total = 0,

        tax_amount = 0

    WHERE id = i.id
      AND organization_id = org;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Complimentary execution did not update the POS item';

    END IF;

    PERFORM set_config(
        'neo.complimentary_execution_approval',
        '',
        true
    );

    -- COMPLIMENTARY_PRICING_INTEGRATION_V1

    SELECT *
    INTO i
    FROM public.pos_order_items
    WHERE id = _item
      AND order_id = _order
      AND organization_id = org;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Complimentary item disappeared during repricing';
    END IF;

    IF i.pricing_type IS DISTINCT FROM 'complimentary'

       OR i.complimentary_id IS DISTINCT FROM a.id

       OR i.unit_price IS DISTINCT FROM a.normal_selling_price

       OR i.discount_amount IS DISTINCT FROM
           round(a.normal_selling_price * a.quantity,2)

       OR i.line_total IS DISTINCT FROM 0

       -- NEO_COMPLIMENTARY_FINANCIAL_POSTCONDITION_V1

       OR i.tax_amount IS DISTINCT FROM 0

       OR i.modifier_total IS DISTINCT FROM 0

       OR i.discount_amount < 0

       OR i.discount_amount::text IN (
           'NaN','Infinity','-Infinity'
       )

    THEN

        RAISE EXCEPTION
            'Canonical POS pricing did not produce the approved complimentary amount';

    END IF;

    IF NOT EXISTS (

        SELECT 1

        FROM public.neo_complimentary_execution_evidence e

        WHERE e.approval_id = a.id
          AND e.organization_id = org
          AND e.order_id = o.id
          AND e.order_item_id = i.id

    ) THEN

        RAISE EXCEPTION
            'Complimentary execution evidence was not recorded';

    END IF;

    RETURN jsonb_build_object(
        'ok',true,
        'reused',false,
        'order_id',o.id,
        'order_item_id',i.id,
        'approval_id',a.id,
        'pricing_type','complimentary'
    );

END;
$function$;


-- Do not expose the execution RPC before the canonical
-- pricing integration and settlement guards are installed.

REVOKE ALL ON FUNCTION
public.neo_pos_execute_complimentary(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_pos_complimentary_context(
    _order uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    o public.pos_orders;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(
           public.has_permission(
               'pos','complimentary.execute'
           )
           OR public.is_org_admin(),
           false
       )

    THEN

        RAISE EXCEPTION
            'Complimentary execution authority required'
            USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = _order

      AND organization_id = org;

    IF NOT FOUND

       OR o.branch_id IS NULL

       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Order outside authorised property'
            USING ERRCODE='42501';

    END IF;

    RETURN jsonb_build_object(

        'order_id',o.id,

        'enabled',has_function_privilege(
            'authenticated',
            'public.neo_pos_execute_complimentary(uuid,uuid,uuid)',
            'EXECUTE'
        ),

        'eligible',coalesce((

            SELECT jsonb_agg(
                to_jsonb(x)
                ORDER BY x.item_name,x.approval_id
            )

            FROM (

                SELECT

                    i.id AS order_item_id,

                    i.item_name,

                    i.quantity,

                    i.unit_price,

                    round(
                        i.quantity*i.unit_price,2
                    ) AS approved_value,

                    a.id AS approval_id,

                    a.reason,

                    a.approved_at,

                    a.beneficiary_name

                FROM public.pos_order_items i

                JOIN public.complimentary_register a

                  ON a.organization_id = org

                  AND a.branch_id = o.branch_id

                  AND a.menu_item_id = i.menu_item_id

                  AND a.quantity = i.quantity

                  AND a.normal_selling_price = i.unit_price

                JOIN public.menu_items m

                  ON m.id = i.menu_item_id

                  AND m.organization_id = org

                WHERE i.order_id = o.id

                  AND i.organization_id = org

                  AND o.status IN (
                      'draft','sent','accepted',
                      'in-preparation','partially-ready','ready',
                      'partially-served','served','awaiting-payment'
                  )

                  AND to_jsonb(o)->>'payment_status'
                      = 'unpaid'

                  AND i.status = 'draft'

                  AND i.sent_at IS NULL

                  AND i.complimentary_id IS NULL

                  AND i.quantity > 0

                  AND i.unit_price >= 0

                  AND i.quantity::text NOT IN (
                      'NaN','Infinity','-Infinity'
                  )

                  AND i.unit_price::text NOT IN (
                      'NaN','Infinity','-Infinity'
                  )

                  AND coalesce(i.modifier_total,0) = 0

                  AND a.status = 'approved'

                  AND a.pricing_type = 'complimentary'

                  AND a.amount_charged = 0

                  AND a.approved_by IS NOT NULL

                  AND a.approved_at IS NOT NULL

                  AND a.requested_by IS NOT NULL

                  AND a.approved_by <> a.requested_by

                  AND public.neo_complimentary_order_binding_valid(
                      to_jsonb(a),
                      to_jsonb(o)
                  ) IS TRUE

                  AND public.neo_record_operationally_enabled(
                      to_jsonb(m)
                  ) IS TRUE

                  AND NOT EXISTS (

                      SELECT 1

                      FROM public.pos_order_item_modifiers x

                      WHERE x.organization_id = org

                        AND x.order_item_id = i.id

                        AND coalesce(x.extra_charge,0) <> 0

                  )

                  AND NOT EXISTS (

                      SELECT 1

                      FROM public.neo_complimentary_execution_evidence e

                      WHERE e.approval_id = a.id

                         OR e.order_item_id = i.id

                  )

                  AND NOT EXISTS (

                      SELECT 1

                      FROM public.pos_order_items existing

                      WHERE existing.complimentary_id = a.id

                  )

                LIMIT 200

            ) x

        ),'[]'::jsonb),

        'executed',coalesce((

            SELECT jsonb_agg(

                jsonb_build_object(

                    'order_item_id',e.order_item_id,

                    'approval_id',e.approval_id,

                    'item_name',i.item_name,

                    'quantity',e.quantity,

                    'executed_at',e.executed_at,

                    'status',i.status

                )

                ORDER BY e.executed_at DESC

            )

            FROM public.neo_complimentary_execution_evidence e

            JOIN public.pos_order_items i

              ON i.id = e.order_item_id

              AND i.organization_id = org

              AND i.order_id = o.id

            WHERE e.organization_id = org

              AND e.branch_id = o.branch_id

              AND e.order_id = o.id

        ),'[]'::jsonb)

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_complimentary_context(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_pos_complimentary_context(uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_complimentary_modifier_mutation_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    v_old_item uuid;

    v_new_item uuid;

    v_item uuid;

    parent_item public.pos_order_items;

BEGIN

    IF TG_OP IN ('UPDATE','DELETE') THEN

        v_old_item := OLD.order_item_id;

    END IF;

    IF TG_OP IN ('INSERT','UPDATE') THEN

        v_new_item := NEW.order_item_id;

    END IF;

    -- Both sides are checked to prevent moving a modifier
    -- into or out of an executed complimentary item.

    FOR v_item IN

        SELECT DISTINCT x.id

        FROM unnest(
            ARRAY[v_old_item,v_new_item]
        ) AS x(id)

        WHERE x.id IS NOT NULL

        ORDER BY x.id

    LOOP

        SELECT *

        INTO parent_item

        FROM public.pos_order_items

        WHERE id = v_item

        FOR UPDATE;

        IF NOT FOUND THEN

            RAISE EXCEPTION
                'Original modifier parent item unavailable';

        END IF;

        IF parent_item.complimentary_id IS NOT NULL

           OR parent_item.pricing_type = 'complimentary'

           OR EXISTS (

               SELECT 1

               FROM public.neo_complimentary_execution_evidence e

               WHERE e.order_item_id = parent_item.id

           )

        THEN

            RAISE EXCEPTION
                'Executed complimentary item modifiers cannot be altered';

        END IF;

    END LOOP;

    IF TG_OP = 'DELETE' THEN

        RETURN OLD;

    END IF;

    RETURN NEW;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_modifier_mutation_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_complimentary_modifier_mutation_guard

ON public.pos_order_item_modifiers;

CREATE TRIGGER
trg_neo_complimentary_modifier_mutation_guard

BEFORE INSERT OR UPDATE OR DELETE

ON public.pos_order_item_modifiers

FOR EACH ROW

EXECUTE FUNCTION
public.neo_complimentary_modifier_mutation_guard();


-- Preserve the original complimentary order item
-- when permanent execution evidence exists.

CREATE OR REPLACE FUNCTION
public.neo_complimentary_item_delete_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

BEGIN

    IF OLD.complimentary_id IS NOT NULL

       OR EXISTS (

           SELECT 1

           FROM public.neo_complimentary_execution_evidence e

           WHERE e.order_item_id = OLD.id

       )

    THEN

        RAISE EXCEPTION
            'Executed complimentary items require controlled cancellation or voiding';

    END IF;

    RETURN OLD;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_item_delete_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_complimentary_item_delete_guard

ON public.pos_order_items;

CREATE TRIGGER
trg_neo_complimentary_item_delete_guard

BEFORE DELETE

ON public.pos_order_items

FOR EACH ROW

EXECUTE FUNCTION
public.neo_complimentary_item_delete_guard();

NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION
public.neo_pos_complimentary_request_context(
    _order uuid
)
RETURNS jsonb

LANGUAGE plpgsql
STABLE
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

    actor uuid := auth.uid();

    o public.pos_orders;

BEGIN

    IF actor IS NULL

       OR org IS NULL

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(

           public.has_permission(
               'restaurant','complimentary','create'
           )

           OR public.is_org_admin(),

           false

       )

    THEN

        RAISE EXCEPTION
            'Complimentary request authority required'
            USING ERRCODE='42501';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id = _order

      AND organization_id = org;

    IF NOT FOUND

       OR o.branch_id IS NULL

       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE

    THEN

        RAISE EXCEPTION
            'Order outside authorised property'
            USING ERRCODE='42501';

    END IF;

    RETURN jsonb_build_object(

        'order_id',o.id,

        'order_number',o.order_number,

        'branch_id',o.branch_id,

        'customer_id',o.customer_id,

        'currency',o.currency,

        'items',coalesce((

            SELECT jsonb_agg(

                jsonb_build_object(

                    'id',i.id,

                    'menu_item_id',i.menu_item_id,

                    'item_name',i.item_name,

                    'quantity',i.quantity,

                    'unit_price',i.unit_price,

                    'normal_value',
                        round(i.quantity*i.unit_price,2)

                )

                ORDER BY i.item_name,i.id

            )

            FROM public.pos_order_items i

            JOIN public.menu_items m

              ON m.id = i.menu_item_id

              AND m.organization_id = org

            WHERE i.organization_id = org

              AND i.order_id = o.id

              AND o.status IN (
                  'draft',
                  'sent',
                  'accepted',
                  'in-preparation',
                  'partially-ready',
                  'ready',
                  'partially-served',
                  'served',
                  'awaiting-payment'
              )

              AND o.payment_status = 'unpaid'

              AND o.paid_total = 0

              AND i.status = 'draft'

              AND i.sent_at IS NULL

              AND i.complimentary_id IS NULL

              AND i.quantity > 0

              AND i.unit_price >= 0

              AND i.quantity::text NOT IN (
                  'NaN','Infinity','-Infinity'
              )

              AND i.unit_price::text NOT IN (
                  'NaN','Infinity','-Infinity'
              )

              AND coalesce(i.modifier_total,0) = 0

              AND public.neo_record_operationally_enabled(
                  to_jsonb(m)
              ) IS TRUE

              AND NOT EXISTS (

                  SELECT 1

                  FROM public.pos_order_item_modifiers x

                  WHERE x.order_item_id = i.id

                    AND coalesce(x.extra_charge,0) <> 0

              )

              AND NOT EXISTS (

                  SELECT 1

                  FROM public.complimentary_register a

                  WHERE a.organization_id = org

                    AND a.branch_id = o.branch_id

                    AND a.reference_type IN (
                        'pos_order','pos-order'
                    )

                    AND a.reference_id::text = o.id::text

                    AND a.menu_item_id = i.menu_item_id

                    AND a.quantity = i.quantity

                    AND a.status IN (
                        'pending',
                        'pending-approval',
                        'pending_approval',
                        'approved'
                    )

                    AND NOT EXISTS (

                        SELECT 1

                        FROM public.neo_complimentary_execution_evidence e

                        WHERE e.approval_id = a.id

                    )

              )

        ),'[]'::jsonb)

    );

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_pos_complimentary_request_context(uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_pos_complimentary_request_context(uuid)
TO authenticated;


-- Validate POS-bound requests against original order
-- facts, rather than accepting client pricing overrides.

CREATE OR REPLACE FUNCTION
public.neo_complimentary_request_order_guard()
RETURNS trigger

LANGUAGE plpgsql
SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    o public.pos_orders;

    item_count bigint;

BEGIN

    IF NEW.pricing_type IS DISTINCT FROM 'complimentary'

       OR coalesce(NEW.reference_type,'') NOT IN (
           'pos_order','pos-order'
       )

    THEN

        RETURN NEW;

    END IF;

    IF TG_OP = 'UPDATE' THEN

        IF OLD.reference_type
           IS DISTINCT FROM NEW.reference_type

           OR OLD.reference_id
              IS DISTINCT FROM NEW.reference_id

           OR OLD.menu_item_id
              IS DISTINCT FROM NEW.menu_item_id

           OR OLD.customer_id
              IS DISTINCT FROM NEW.customer_id

           OR OLD.employee_id
              IS DISTINCT FROM NEW.employee_id

           OR OLD.quantity
              IS DISTINCT FROM NEW.quantity

           OR OLD.normal_selling_price
              IS DISTINCT FROM NEW.normal_selling_price

           OR OLD.amount_charged
              IS DISTINCT FROM NEW.amount_charged

        THEN

            RAISE EXCEPTION
              'POS complimentary request identity cannot be changed';

        END IF;

        RETURN NEW;

    END IF;

    IF auth.uid() IS NULL

       OR public.current_org_id()
          IS DISTINCT FROM NEW.organization_id

       OR public.current_access_scope() IS NULL

       OR public.current_access_scope() = 'technical'

       OR NOT coalesce(

           public.has_permission(
               'restaurant','complimentary','create'
           )

           OR public.is_org_admin(),

           false

       )

    THEN

        RAISE EXCEPTION
            'Complimentary request access denied'
            USING ERRCODE='42501';

    END IF;

    IF NEW.reference_id IS NULL

       OR NEW.menu_item_id IS NULL

       OR NEW.requested_by
          IS DISTINCT FROM auth.uid()

       OR NEW.employee_id IS NOT NULL

       OR NEW.amount_charged IS DISTINCT FROM 0

    THEN

        RAISE EXCEPTION
            'Valid original POS order and beneficiary required';

    END IF;

    SELECT *
    INTO o

    FROM public.pos_orders

    WHERE id::text = NEW.reference_id::text

      AND organization_id = NEW.organization_id

      AND branch_id = NEW.branch_id

    FOR UPDATE;

    IF NOT FOUND

       OR public.neo_branch_in_scope(
           o.branch_id
       ) IS NOT TRUE

       OR o.payment_status IS DISTINCT FROM 'unpaid'

       OR o.paid_total IS DISTINCT FROM 0

       OR coalesce(o.status,'') NOT IN (
           'draft',
           'sent',
           'accepted',
           'in-preparation',
           'partially-ready',
           'ready',
           'partially-served',
           'served',
           'awaiting-payment'
       )

    THEN

        RAISE EXCEPTION
            'Original unpaid POS order is unavailable';

    END IF;

    IF NEW.customer_id IS DISTINCT FROM o.customer_id THEN

        RAISE EXCEPTION
            'Complimentary customer differs from original order';

    END IF;

    SELECT count(*)

    INTO item_count

    FROM public.pos_order_items i

    WHERE i.order_id = o.id

      AND i.organization_id = NEW.organization_id

      AND i.menu_item_id = NEW.menu_item_id

      AND i.quantity = NEW.quantity

      AND i.unit_price = NEW.normal_selling_price

      AND i.status = 'draft'

      AND i.sent_at IS NULL

      AND i.complimentary_id IS NULL

      AND i.quantity > 0

      AND i.unit_price >= 0

      AND i.quantity::text NOT IN (
          'NaN','Infinity','-Infinity'
      )

      AND i.unit_price::text NOT IN (
          'NaN','Infinity','-Infinity'
      )

      AND coalesce(i.modifier_total,0) = 0

      AND NOT EXISTS (

          SELECT 1

          FROM public.pos_order_item_modifiers x

          WHERE x.order_item_id = i.id

            AND coalesce(x.extra_charge,0) <> 0

      );

    IF item_count <> 1 THEN

        RAISE EXCEPTION
            'Complimentary request requires one unambiguous matching draft POS item';

    END IF;

    RETURN NEW;

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_complimentary_request_order_guard()
FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS
trg_neo_complimentary_request_order_guard
ON public.complimentary_register;

CREATE TRIGGER
trg_neo_complimentary_request_order_guard

BEFORE INSERT OR UPDATE

ON public.complimentary_register

FOR EACH ROW

EXECUTE FUNCTION
public.neo_complimentary_request_order_guard();

NOTIFY pgrst,'reload schema';

COMMIT;