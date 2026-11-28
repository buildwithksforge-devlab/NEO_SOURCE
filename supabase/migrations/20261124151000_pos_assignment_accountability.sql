-- NE? POS permanent assignment accountability.
--
-- Preserves original order ownership and every future waiter change.
-- Existing orders receive a baseline observation only.
--
-- History is append-only.
-- Does not change existing POS orders, payments or allocations.

CREATE TABLE public.pos_order_assignment_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL,
    branch_id uuid,

    -- Preserve historical attribution even after a controlled
    -- hard deletion of an unused draft order.
    -- Visibility is still constrained through the associated order.
    order_id uuid NOT NULL,

    event_type text NOT NULL,

    previous_waiter_id uuid,
    new_waiter_id uuid,

    original_creator_id uuid,

    changed_by uuid,

    event_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pos_assignment_event_type_chk
        CHECK (
            event_type IN (
                'baseline',
                'created',
                'assigned',
                'transferred',
                'unassigned'
            )
        )
);

CREATE INDEX pos_assignment_order_history_idx
ON public.pos_order_assignment_history (
    order_id,
    event_at,
    id
);

CREATE INDEX pos_assignment_org_branch_history_idx
ON public.pos_order_assignment_history (
    organization_id,
    branch_id,
    event_at
);

-- Existing POS RLS remains the authority for order visibility.
-- A user may read assignment history only when the associated
-- order is visible to them under the established POS policies.


-- Verify the permanent order identity when an audit event
-- is recorded. A later controlled deletion does not remove
-- events that have already passed this validation.

CREATE FUNCTION public.neo_verify_pos_assignment_history_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _order record;
BEGIN
    SELECT
        o.organization_id,
        o.branch_id,
        o.created_by
    INTO _order
    FROM public.pos_orders o
    WHERE o.id = NEW.order_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Assignment history requires an existing POS order'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.organization_id IS DISTINCT FROM
       _order.organization_id
       OR NEW.branch_id IS DISTINCT FROM
       _order.branch_id
       OR NEW.original_creator_id IS DISTINCT FROM
       _order.created_by
    THEN
        RAISE EXCEPTION
            'Assignment history order identity mismatch'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_verify_pos_assignment_history_insert()
FROM PUBLIC, anon, authenticated;

CREATE TRIGGER neo_pos_assignment_history_identity
BEFORE INSERT
ON public.pos_order_assignment_history
FOR EACH ROW
EXECUTE FUNCTION
    public.neo_verify_pos_assignment_history_insert();

ALTER TABLE public.pos_order_assignment_history
ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_assignment_history_visible_order
ON public.pos_order_assignment_history
FOR SELECT
TO authenticated
USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
        SELECT 1
        FROM public.pos_orders o
        WHERE o.id = order_id
          AND o.organization_id = organization_id
    )
);

REVOKE ALL
ON public.pos_order_assignment_history
FROM PUBLIC, anon, authenticated;

GRANT SELECT
ON public.pos_order_assignment_history
TO authenticated;

-- Block historical modification, including attempts made
-- directly by a privileged database role.

CREATE FUNCTION public.neo_block_pos_assignment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION
        'POS assignment history is append-only'
        USING ERRCODE = '42501';
END;
$function$;

CREATE TRIGGER neo_pos_assignment_history_immutable
BEFORE UPDATE OR DELETE
ON public.pos_order_assignment_history
FOR EACH ROW
EXECUTE FUNCTION
    public.neo_block_pos_assignment_history_mutation();

-- Automatic audit.
-- SECURITY DEFINER is restricted to the trigger's audit insert.
-- Do not grant application users direct INSERT on the history table.

CREATE FUNCTION public.neo_record_pos_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    _event text;
BEGIN

    IF TG_OP = 'INSERT' THEN

        IF NEW.waiter_id IS NULL THEN
            _event := 'created';
        ELSE
            _event := 'assigned';
        END IF;

        INSERT INTO public.pos_order_assignment_history (
            organization_id,
            branch_id,
            order_id,
            event_type,
            previous_waiter_id,
            new_waiter_id,
            original_creator_id,
            changed_by
        )
        VALUES (
            NEW.organization_id,
            NEW.branch_id,
            NEW.id,
            _event,
            NULL,
            NEW.waiter_id,
            NEW.created_by,
            auth.uid()
        );

        RETURN NEW;

    END IF;

    IF OLD.waiter_id IS NOT DISTINCT FROM NEW.waiter_id THEN
        RETURN NEW;
    END IF;

    IF OLD.waiter_id IS NULL THEN
        _event := 'assigned';

    ELSIF NEW.waiter_id IS NULL THEN
        _event := 'unassigned';

    ELSE
        _event := 'transferred';
    END IF;

    INSERT INTO public.pos_order_assignment_history (
        organization_id,
        branch_id,
        order_id,
        event_type,
        previous_waiter_id,
        new_waiter_id,
        original_creator_id,
        changed_by
    )
    VALUES (
        NEW.organization_id,
        NEW.branch_id,
        NEW.id,
        _event,
        OLD.waiter_id,
        NEW.waiter_id,
        NEW.created_by,
        auth.uid()
    );

    RETURN NEW;

END;
$function$;

REVOKE ALL
ON FUNCTION public.neo_record_pos_assignment_change()
FROM PUBLIC;

CREATE TRIGGER neo_pos_order_assignment_audit
AFTER INSERT OR UPDATE OF waiter_id
ON public.pos_orders
FOR EACH ROW
EXECUTE FUNCTION
    public.neo_record_pos_assignment_change();

-- Capture the assignment observed at migration time.
-- This is NOT a reconstruction of past transfers.
-- It does not modify existing pos_orders rows.

INSERT INTO public.pos_order_assignment_history (
    organization_id,
    branch_id,
    order_id,
    event_type,
    previous_waiter_id,
    new_waiter_id,
    original_creator_id,
    changed_by
)
SELECT
    o.organization_id,
    o.branch_id,
    o.id,
    'baseline',
    NULL,
    o.waiter_id,
    o.created_by,
    NULL
FROM public.pos_orders o;
