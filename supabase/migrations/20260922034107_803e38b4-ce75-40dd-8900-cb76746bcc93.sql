CREATE OR REPLACE FUNCTION public.neo_guest_notify_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.customer_id is null then return new; end if;

  if tg_op = 'INSERT' and new.status not in ('confirmed','cancelled','no_show') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'stay', 'booking_received',
      'Booking received',
      'We have your booking ' || coalesce(new.confirmation_number, '') || ' for ' || new.arrival_date || '. Reception will confirm it shortly.',
      case when new.confirmation_number is null then 'trips' else 'reservations/' || new.confirmation_number end,
      'pms', new.id, 'res-received:' || new.id
    );
  end if;

  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or coalesce(old.status, '') is distinct from 'confirmed') then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'stay', 'booking_confirmed',
      'Booking confirmed',
      'Your stay ' || coalesce(new.confirmation_number, '') || ' is confirmed for ' || new.arrival_date || '.',
      case when new.confirmation_number is null then 'trips' else 'reservations/' || new.confirmation_number end,
      'pms', new.id, 'res-confirmed:' || new.id
    );
  end if;

  if new.room_id is not null
     and (tg_op = 'INSERT' or old.room_id is null)
     and new.status in ('confirmed', 'guaranteed')
     and new.arrival_date <= current_date + 1 then
    perform public.neo_guest_notify(
      new.organization_id, new.branch_id, new.customer_id, 'stay', 'checkin_ready',
      'Your room is ready',
      'Your room has been assigned. Reception can check you in.',
      case when new.confirmation_number is null then 'trips' else 'reservations/' || new.confirmation_number end,
      'pms', new.id, 'res-ready:' || new.id
    );
  end if;

  return new;
end $function$;