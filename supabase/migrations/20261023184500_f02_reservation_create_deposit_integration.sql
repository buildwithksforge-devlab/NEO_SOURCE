-- NEØ F02: Reservation creation with deposit configuration.
-- Review against the deployed function before applying.

CREATE OR REPLACE FUNCTION public.neo_reservation_create(_payload jsonb, _idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _room uuid := NULLIF(_payload->>'room_id','')::uuid;
  _room_type uuid := NULLIF(_payload->>'room_type_id','')::uuid;
  _arrival date := (_payload->>'arrival_date')::date;
  _departure date := (_payload->>'departure_date')::date;
  _adults integer := COALESCE((_payload->>'adults')::integer,1);
  _children integer := COALESCE((_payload->>'children')::integer,0);
  _group uuid := NULLIF(_payload->>'group_booking_id','')::uuid;
  _confirmation text;
  _existing public.reservations;
  _created public.reservations;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT (public.has_permission('pms','reservations.create') OR public.has_permission('pms','reservations.edit')) THEN
    RAISE EXCEPTION 'Not permitted to create reservations';
  END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A reservation idempotency key is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=_org) THEN RAISE EXCEPTION 'Select a valid property'; END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN RAISE EXCEPTION 'Departure must be after arrival'; END IF;

  SELECT * INTO _existing FROM public.reservations WHERE organization_id=_org AND idempotency_key=_idempotency_key LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'id',_existing.id,'confirmation_number',_existing.confirmation_number,'room_id',_existing.room_id);
  END IF;

  -- F02: Validate per-reservation deposit configuration.
  IF _payload ? 'deposit_basis' THEN

    IF COALESCE(_payload->>'deposit_basis','')
       NOT IN ('percentage','fixed') THEN
      RAISE EXCEPTION 'Invalid reservation deposit basis';
    END IF;

    IF NULLIF(_payload->>'deposit_value','') IS NULL THEN
      RAISE EXCEPTION 'Reservation deposit value is required';
    END IF;

    IF (_payload->>'deposit_value')::numeric < 0 THEN
      RAISE EXCEPTION 'Reservation deposit value cannot be negative';
    END IF;

    IF (_payload->>'deposit_basis') = 'percentage'
       AND (_payload->>'deposit_value')::numeric > 100 THEN
      RAISE EXCEPTION 'Deposit percentage cannot exceed 100';
    END IF;

    IF COALESCE((_payload->>'total_amount')::numeric,0) < 0 THEN
      RAISE EXCEPTION 'Reservation total cannot be negative';
    END IF;

    IF round(
      CASE
        WHEN _payload->>'deposit_basis' = 'percentage'
        THEN COALESCE((_payload->>'total_amount')::numeric,0)
             * (_payload->>'deposit_value')::numeric / 100
        ELSE (_payload->>'deposit_value')::numeric
      END, 2
    ) <> COALESCE((_payload->>'deposit_required')::numeric,0) THEN
      RAISE EXCEPTION 'Deposit requirement does not match configuration';
    END IF;

    IF COALESCE((_payload->>'deposit_required')::numeric,0)
       > COALESCE((_payload->>'total_amount')::numeric,0) THEN
      RAISE EXCEPTION 'Deposit cannot exceed reservation total';
    END IF;

  END IF;
  IF _room IS NOT NULL THEN
    PERFORM 1 FROM public.rooms WHERE id=_room AND organization_id=_org AND branch_id=_branch FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The selected room does not belong to this property'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pms_available_rooms(_branch,_arrival,_departure,_room_type,_adults,_children,_group) a
       WHERE a.room_id=_room
    ) THEN RAISE EXCEPTION 'The selected room is no longer available for these stay dates'; END IF;
  END IF;

  _confirmation := COALESCE(NULLIF(btrim(COALESCE(_payload->>'confirmation_number','')),''),
                            public.neo_reservation_confirmation_number(_org));

  INSERT INTO public.reservations
    (organization_id,branch_id,confirmation_number,customer_id,corporate_account_id,group_booking_id,
     booking_source,reservation_type,external_reference,arrival_date,departure_date,nights,adults,children,
     infants,room_type_id,room_id,rate_plan_id,meal_plan_id,nightly_rate,tax_amount,discount_amount,total_amount,
     deposit_required,deposit_basis,deposit_value,balance,guarantee_method,special_requests,is_vip,status,rate_source,rate_override_reason,
     rate_quoted_amount,idempotency_key,created_by)
  VALUES
    (_org,_branch,_confirmation,NULLIF(_payload->>'customer_id','')::uuid,
     NULLIF(_payload->>'corporate_account_id','')::uuid,_group,COALESCE(NULLIF(_payload->>'booking_source',''),'direct'),
     COALESCE(NULLIF(_payload->>'reservation_type',''),'individual'),NULLIF(_payload->>'external_reference',''),
     _arrival,_departure,(_departure-_arrival),_adults,_children,COALESCE((_payload->>'infants')::integer,0),
     _room_type,_room,NULLIF(_payload->>'rate_plan_id','')::uuid,NULLIF(_payload->>'meal_plan_id','')::uuid,
     COALESCE((_payload->>'nightly_rate')::numeric,0),COALESCE((_payload->>'tax_amount')::numeric,0),
     COALESCE((_payload->>'discount_amount')::numeric,0),COALESCE((_payload->>'total_amount')::numeric,0),
     COALESCE((_payload->>'deposit_required')::numeric,0),
     NULLIF(_payload->>'deposit_basis',''),
     NULLIF(_payload->>'deposit_value','')::numeric,
     COALESCE((_payload->>'balance')::numeric,0),
     COALESCE(NULLIF(_payload->>'guarantee_method',''),'none'),COALESCE(_payload->>'special_requests',''),
     COALESCE((_payload->>'is_vip')::boolean,false),COALESCE(NULLIF(_payload->>'status',''),'tentative'),
     NULLIF(_payload->>'rate_source',''),NULLIF(_payload->>'rate_override_reason',''),
     NULLIF(_payload->>'rate_quoted_amount','')::numeric,_idempotency_key,auth.uid())
  RETURNING * INTO _created;

  IF _room IS NOT NULL THEN PERFORM public.pms_assign_room(_created.id,_room,'Selected during reservation creation'); END IF;
  INSERT INTO public.reservation_history (organization_id,reservation_id,action,new_value,changed_by)
  VALUES (_org,_created.id,'created',jsonb_build_object('status',_created.status,'arrival',_arrival,'departure',_departure,'nights',_created.nights,'room_id',_room),auth.uid());
  PERFORM public.emit_domain_event(_org,_branch,'reservation.created','pms',_created.id,
          jsonb_build_object('confirmation',_created.confirmation_number,'arrival',_arrival,'departure',_departure,'total',_created.total_amount,'room_id',_room),
          'reservation.created:'||_created.id, _created.customer_id);
  RETURN jsonb_build_object('ok',true,'idempotent',false,'id',_created.id,'confirmation_number',_created.confirmation_number,'room_id',_created.room_id);
END;
$function$;
