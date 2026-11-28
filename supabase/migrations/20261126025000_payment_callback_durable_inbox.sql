-- Durable callback inbox.
-- Internal transport infrastructure only.
-- Does not independently confirm a payment or post financial entries.

CREATE TABLE public.neo_payment_callback_inbox (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    provider text NOT NULL,

    endpoint_scope text NOT NULL,

    event_key text NOT NULL,

    payload jsonb NOT NULL,

    status text NOT NULL DEFAULT 'pending',

    attempt_count integer NOT NULL DEFAULT 0,

    delivery_count integer NOT NULL DEFAULT 1,

    received_at timestamptz NOT NULL DEFAULT now(),

    last_received_at timestamptz NOT NULL DEFAULT now(),

    available_at timestamptz NOT NULL DEFAULT now(),

    lease_token uuid,

    lease_expires_at timestamptz,

    completed_at timestamptz,

    last_error_code text,

    CONSTRAINT neo_payment_callback_provider_check
        CHECK (
            length(provider) BETWEEN 1 AND 50
        ),

    CONSTRAINT neo_payment_callback_scope_check
        CHECK (
            length(endpoint_scope) BETWEEN 1 AND 200
        ),

    CONSTRAINT neo_payment_callback_event_key_check
        CHECK (
            length(event_key) BETWEEN 1 AND 200
        ),

    CONSTRAINT neo_payment_callback_payload_check
        CHECK (
            jsonb_typeof(payload) = 'object'
            AND octet_length(payload::text) <= 65536
        ),

    CONSTRAINT neo_payment_callback_status_check
        CHECK (
            status IN (
                'pending',
                'processing',
                'retry',
                'completed',
                'dead-letter'
            )
        ),

    CONSTRAINT neo_payment_callback_attempt_check
        CHECK (
            attempt_count BETWEEN 0 AND 10
            AND delivery_count >= 1
        ),

    CONSTRAINT neo_payment_callback_lease_check
        CHECK (
            (
                status = 'processing'
                AND lease_token IS NOT NULL
                AND lease_expires_at IS NOT NULL
            )
            OR (
                status <> 'processing'
                AND lease_token IS NULL
                AND lease_expires_at IS NULL
            )
        ),

    CONSTRAINT neo_payment_callback_identity
        UNIQUE (
            provider,
            endpoint_scope,
            event_key
        )

);

ALTER TABLE public.neo_payment_callback_inbox
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL
ON public.neo_payment_callback_inbox
FROM PUBLIC,anon,authenticated;

CREATE INDEX neo_payment_callback_available_idx
ON public.neo_payment_callback_inbox (
    available_at,
    received_at,
    id
)
WHERE status IN ('pending','retry');

CREATE INDEX neo_payment_callback_expired_lease_idx
ON public.neo_payment_callback_inbox (
    lease_expires_at,
    id
)
WHERE status = 'processing';

CREATE INDEX neo_payment_callback_exception_idx
ON public.neo_payment_callback_inbox (
    received_at,
    id
)
WHERE status = 'dead-letter';


-- Accept a provider event after upstream authentication.
-- The caller must derive a stable event identity from trusted
-- provider evidence. Never accept an arbitrary cashier claim.

CREATE OR REPLACE FUNCTION public.neo_payment_callback_accept(
    _provider text,
    _endpoint_scope text,
    _event_key text,
    _payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    v_event public.neo_payment_callback_inbox%ROWTYPE;

    v_provider text := lower(btrim(_provider));

    v_scope text := btrim(_endpoint_scope);

    v_key text := btrim(_event_key);

BEGIN

    IF v_provider IS NULL
       OR v_scope IS NULL
       OR v_key IS NULL
       OR length(v_provider) NOT BETWEEN 1 AND 50
       OR length(v_scope) NOT BETWEEN 1 AND 200
       OR length(v_key) NOT BETWEEN 1 AND 200
       OR jsonb_typeof(_payload) IS DISTINCT FROM 'object'
       OR octet_length(_payload::text) > 65536
    THEN

        RAISE EXCEPTION 'Invalid payment callback envelope';

    END IF;

    INSERT INTO public.neo_payment_callback_inbox (
        provider,
        endpoint_scope,
        event_key,
        payload
    )
    VALUES (
        v_provider,
        v_scope,
        v_key,
        _payload
    )
    ON CONFLICT (
        provider,
        endpoint_scope,
        event_key
    )
    DO NOTHING
    RETURNING * INTO v_event;

    IF v_event.id IS NOT NULL THEN

        RETURN jsonb_build_object(
            'accepted',true,
            'event_id',v_event.id,
            'duplicate',false,
            'status',v_event.status
        );

    END IF;

    SELECT *
    INTO v_event
    FROM public.neo_payment_callback_inbox i
    WHERE i.provider = v_provider
      AND i.endpoint_scope = v_scope
      AND i.event_key = v_key
    FOR UPDATE;

    IF v_event.id IS NULL THEN

        RAISE EXCEPTION 'Callback acceptance requires retry';

    END IF;

    IF v_event.payload IS DISTINCT FROM _payload THEN

        RAISE EXCEPTION
            'Conflicting callback payload for existing event identity';

    END IF;

    UPDATE public.neo_payment_callback_inbox

    SET delivery_count = delivery_count + 1,

        last_received_at = now()

    WHERE id = v_event.id;

    RETURN jsonb_build_object(
        'accepted',true,
        'event_id',v_event.id,
        'duplicate',true,
        'status',v_event.status
    );

END;
$function$;


-- Claim bounded batches using SKIP LOCKED.
-- An interrupted consumer cannot permanently retain an event.

CREATE OR REPLACE FUNCTION public.neo_payment_callback_claim(
    _limit integer DEFAULT 25,
    _lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.neo_payment_callback_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    v_active integer;
    v_capacity integer;
    v_global_limit integer := 20;
BEGIN

    IF _limit IS NULL
       OR _limit NOT BETWEEN 1 AND 100
       OR _lease_seconds IS NULL
       OR _lease_seconds NOT BETWEEN 30 AND 300
    THEN

        RAISE EXCEPTION 'Invalid callback processing batch';

    END IF;

    -- Retain exhausted interrupted events for investigation.

    WITH exhausted AS (

        SELECT i.id

        FROM public.neo_payment_callback_inbox i

        WHERE i.status = 'processing'
          AND i.lease_expires_at <= now()
          AND i.attempt_count >= 10

        ORDER BY i.lease_expires_at

        LIMIT _limit

        FOR UPDATE SKIP LOCKED

    )

    UPDATE public.neo_payment_callback_inbox i

    SET status = 'dead-letter',

        last_error_code = 'lease-attempts-exhausted',

        lease_token = NULL,

        lease_expires_at = NULL

    FROM exhausted e

    WHERE i.id = e.id;    -- PAYMENT_GLOBAL_CONCURRENCY_V1

    -- Serialise short claim transactions, not financial processing.

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'neo-payment-callback-global-claim',
            0
        )
    );

    SELECT count(*)::integer
    INTO v_active
    FROM public.neo_payment_callback_inbox i
    WHERE i.status = 'processing'
      AND i.lease_expires_at > now();

    v_capacity := least(
        _limit,
        greatest(0,v_global_limit-v_active)
    );

    IF v_capacity = 0 THEN
        RETURN;
    END IF;

    RETURN QUERY

    WITH candidates AS (

        SELECT i.id

        FROM public.neo_payment_callback_inbox i

        WHERE i.attempt_count < 10

          AND (

              (
                  i.status IN ('pending','retry')
                  AND i.available_at <= now()
              )

              OR (

                  i.status = 'processing'

                  AND i.lease_expires_at <= now()

              )

          )        ORDER BY i.available_at,i.received_at,i.id

        LIMIT v_capacity

        FOR UPDATE SKIP LOCKED

    )

    UPDATE public.neo_payment_callback_inbox i

    SET status = 'processing',

        attempt_count = i.attempt_count + 1,

        lease_token = gen_random_uuid(),

        lease_expires_at =

            now() + make_interval(
                secs => _lease_seconds
            )

    FROM candidates c

    WHERE i.id = c.id

    RETURNING i.*;

END;
$function$;


-- Complete transport processing only.
-- The consumer must first obtain a definitive result from the
-- existing canonical payment settlement/reconciliation command.

CREATE OR REPLACE FUNCTION public.neo_payment_callback_complete(
    _event uuid,
    _lease uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    UPDATE public.neo_payment_callback_inbox

    SET status = 'completed',

        completed_at = now(),

        lease_token = NULL,

        lease_expires_at = NULL,

        last_error_code = NULL

    WHERE id = _event

      AND status = 'processing'

      AND lease_token = _lease

      AND lease_expires_at > now();

    RETURN FOUND;

END;
$function$;


-- Retry transport failures using bounded exponential backoff
-- with jitter. Do not store raw provider errors or credentials.

CREATE OR REPLACE FUNCTION public.neo_payment_callback_fail(
    _event uuid,
    _lease uuid,
    _error_code text,
    _permanent boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE

    v_event public.neo_payment_callback_inbox%ROWTYPE;

    v_delay integer;

    v_status text;

BEGIN

    IF _error_code IS NULL
       OR _error_code !~ '^[a-z0-9_-]{1,80}$'
       OR _permanent IS NULL
    THEN

        RAISE EXCEPTION 'Invalid callback error classification';

    END IF;

    SELECT *

    INTO v_event

    FROM public.neo_payment_callback_inbox i

    WHERE i.id = _event

      AND i.status = 'processing'

      AND i.lease_token = _lease

      AND i.lease_expires_at > now()

    FOR UPDATE;

    IF v_event.id IS NULL THEN

        RETURN jsonb_build_object(
            'ok',false,
            'reason','stale-lease'
        );

    END IF;

    IF _permanent OR v_event.attempt_count >= 10 THEN

        v_status := 'dead-letter';

        v_delay := 0;

    ELSE

        v_status := 'retry';

        v_delay := least(
            3600,
            (
                5 * power(
                    2,
                    v_event.attempt_count - 1
                )
            )::integer
            + floor(random()*10)::integer
        );

    END IF;

    UPDATE public.neo_payment_callback_inbox

    SET status = v_status,

        available_at = now() +
            make_interval(secs => v_delay),

        lease_token = NULL,

        lease_expires_at = NULL,

        last_error_code = _error_code

    WHERE id = v_event.id;

    RETURN jsonb_build_object(

        'ok',true,

        'status',v_status,

        'retry_after_seconds',v_delay,

        'attempt_count',v_event.attempt_count

    );

END;
$function$;


-- Internal monitoring; no raw payment payloads returned.

CREATE OR REPLACE FUNCTION public.neo_payment_callback_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$

    SELECT jsonb_build_object(

        'total_events',count(*),

        'total_deliveries',
            coalesce(sum(delivery_count),0),

        'duplicate_deliveries',
            coalesce(sum(delivery_count-1),0),

        'pending',
            count(*) FILTER (
                WHERE status = 'pending'
            ),

        'processing',
            count(*) FILTER (
                WHERE status = 'processing'
            ),

        'retry',
            count(*) FILTER (
                WHERE status = 'retry'
            ),

        'completed',
            count(*) FILTER (
                WHERE status = 'completed'
            ),

        'dead_letter',
            count(*) FILTER (
                WHERE status = 'dead-letter'
            ),

        'expired_leases',
            count(*) FILTER (
                WHERE status = 'processing'
                  AND lease_expires_at <= now()
            ),

        'oldest_unresolved_seconds',
            coalesce(

                extract(
                    epoch FROM now() -
                    min(received_at) FILTER (
                        WHERE status IN (
                            'pending',
                            'processing',
                            'retry'
                        )
                    )
                ),

                0

            )

    )

    FROM public.neo_payment_callback_inbox;

$function$;


-- Keep all commands disabled for browser clients.
-- Service-role activation is deferred until the authenticated
-- callback route and consumer integration have been verified.

REVOKE ALL ON FUNCTION
    public.neo_payment_callback_accept(text,text,text,jsonb)
FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION
    public.neo_payment_callback_claim(integer,integer)
FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION
    public.neo_payment_callback_complete(uuid,uuid)
FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION
    public.neo_payment_callback_fail(uuid,uuid,text,boolean)
FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION
    public.neo_payment_callback_health()
FROM PUBLIC,anon,authenticated,service_role;


CREATE TABLE public.neo_payment_callback_replay_audit (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    event_id uuid NOT NULL
        REFERENCES public.neo_payment_callback_inbox(id),

    previous_attempt_count integer NOT NULL,

    previous_error_code text,

    operator_reference text NOT NULL,

    reason text NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now()

);

ALTER TABLE public.neo_payment_callback_replay_audit
ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.neo_payment_callback_replay_audit
FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.neo_payment_callback_requeue(
    _event uuid,
    _operator_reference text,
    _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
DECLARE
    e public.neo_payment_callback_inbox%ROWTYPE;
BEGIN

    IF length(btrim(coalesce(_operator_reference,'')))
          NOT BETWEEN 1 AND 200

       OR length(btrim(coalesce(_reason,'')))
          NOT BETWEEN 10 AND 2000

    THEN

        RAISE EXCEPTION 'Recovery operator and reason required';

    END IF;

    SELECT *
    INTO e
    FROM public.neo_payment_callback_inbox
    WHERE id = _event
    FOR UPDATE;

    IF e.id IS NULL
       OR e.status <> 'dead-letter'
    THEN
        RAISE EXCEPTION 'Only dead-letter events may be requeued';
    END IF;

    INSERT INTO public.neo_payment_callback_replay_audit (
        event_id,
        previous_attempt_count,
        previous_error_code,
        operator_reference,
        reason
    )
    VALUES (
        e.id,
        e.attempt_count,
        e.last_error_code,
        _operator_reference,
        _reason
    );

    UPDATE public.neo_payment_callback_inbox

    SET status = 'retry',

        attempt_count = 0,

        available_at = now(),

        lease_token = NULL,

        lease_expires_at = NULL,

        completed_at = NULL

    WHERE id = e.id;

    RETURN jsonb_build_object(
        'ok',true,
        'event_id',e.id,
        'status','retry'
    );

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_requeue(uuid,text,text)
FROM PUBLIC,anon,authenticated,service_role;

-- PAYMENT_SCHEDULER_RECOVERY_V1

REVOKE ALL ON public.neo_payment_callback_inbox
FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.neo_payment_callback_renew(
    _event uuid,
    _lease uuid,
    _seconds integer DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $function$
BEGIN

    IF _seconds IS NULL
       OR _seconds NOT BETWEEN 30 AND 300
    THEN
        RAISE EXCEPTION 'Invalid callback lease extension';
    END IF;

    UPDATE public.neo_payment_callback_inbox

    SET lease_expires_at =
        clock_timestamp() +
        make_interval(secs => _seconds)

    WHERE id = _event
      AND status = 'processing'
      AND lease_token = _lease
      AND lease_expires_at > clock_timestamp();

    RETURN FOUND;

END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_renew(uuid,uuid,integer)
FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX neo_payment_callback_active_scope_idx
ON public.neo_payment_callback_inbox (
    endpoint_scope,
    lease_expires_at
)
WHERE status = 'processing';


-- PAYMENT_RESTRICTED_EXECUTION_V1

-- Callback evidence remains inaccessible through
-- direct table operations.

REVOKE ALL ON TABLE
public.neo_payment_callback_inbox
FROM PUBLIC,anon,authenticated,service_role;

-- Only the trusted server role receives access
-- to the narrow intake and processing functions.

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_accept(
    text,text,text,jsonb
)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_claim(
    integer,integer
)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_complete(
    uuid,uuid
)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_fail(
    uuid,uuid,text,boolean
)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_renew(
    uuid,uuid,integer
)
TO service_role;

GRANT EXECUTE ON FUNCTION
public.neo_payment_callback_health()
TO service_role;

-- Preserve restricted public and staff access.

REVOKE ALL ON FUNCTION
public.neo_payment_callback_accept(
    text,text,text,jsonb
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_claim(
    integer,integer
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_complete(
    uuid,uuid
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_fail(
    uuid,uuid,text,boolean
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_renew(
    uuid,uuid,integer
)
FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION
public.neo_payment_callback_health()
FROM PUBLIC,anon,authenticated;
