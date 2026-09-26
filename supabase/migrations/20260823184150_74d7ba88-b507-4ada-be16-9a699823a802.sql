-- Allow trusted system-posting paths (maintenance triggers) to move room status
-- without granting the acting user manual room-status rights.
create or replace function public.neo_wo_room_block_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_block boolean; v_release boolean;
begin
  if new.room_id is null then return new; end if;

  v_block := new.blocks_room
             and new.status not in ('completed','closed','cancelled','verified')
             and (tg_op = 'INSERT' or coalesce(old.blocks_room,false) is distinct from true
                  or coalesce(old.status,'') in ('completed','closed','cancelled','verified'));

  v_release := tg_op = 'UPDATE'
               and coalesce(old.blocks_room,false)
               and (new.status in ('closed','cancelled') or new.blocks_room = false);

  if not (v_block or v_release) then return new; end if;

  perform set_config('neo.system_posting','on', true);
  if v_block then
    perform public.ops_set_room_status(
      new.room_id, null, coalesce(nullif(new.block_status,''),'out-of-order'),
      new.description, 'maintenance', new.id);
  else
    perform public.ops_set_room_status(
      new.room_id, 'dirty', 'operational', 'Maintenance closed', 'maintenance', new.id);
    update public.maintenance_work_orders set blocks_room = false, block_status = null
      where id = new.id and (blocks_room or block_status is not null);
  end if;
  perform set_config('neo.system_posting','off', true);
  return new;
end $$;

revoke all on function public.neo_wo_room_block_sync() from public, anon, authenticated;

create or replace function public.ops_set_room_status(_room uuid, _housekeeping_status text default null, _maintenance_status text default null, _reason text default null, _source_module text default 'housekeeping', _reference uuid default null, _occupancy_status text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_org uuid := current_org_id(); v_room record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  SELECT * INTO v_room FROM rooms WHERE id = _room AND organization_id = v_org FOR UPDATE;
  IF v_room IS NULL THEN RAISE EXCEPTION 'Unknown room'; END IF;
  IF NOT (public.neo_system_posting() OR has_permission('housekeeping','edit') OR has_permission('maintenance','edit') OR has_permission('pms','rooms.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change room status';
  END IF;

  IF _housekeeping_status IS NOT NULL AND _housekeeping_status IS DISTINCT FROM v_room.housekeeping_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'housekeeping_status', v_room.housekeeping_status, _housekeeping_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET housekeeping_status = _housekeeping_status,
      last_cleaned_at = CASE WHEN _housekeeping_status IN ('clean','inspected') THEN now() ELSE last_cleaned_at END,
      last_inspected_at = CASE WHEN _housekeeping_status = 'inspected' THEN now() ELSE last_inspected_at END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  IF _maintenance_status IS NOT NULL AND _maintenance_status IS DISTINCT FROM v_room.maintenance_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'maintenance_status', v_room.maintenance_status, _maintenance_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET maintenance_status = _maintenance_status,
      out_of_order_reason = CASE WHEN _maintenance_status IN ('out-of-order','out-of-service','under-maintenance') THEN _reason ELSE NULL END,
      updated_at = now()
    WHERE id = _room;
  END IF;

  IF _occupancy_status IS NOT NULL AND _occupancy_status IS DISTINCT FROM v_room.occupancy_status THEN
    INSERT INTO room_status_history (organization_id, branch_id, room_id, field, previous_value, new_value, reason, changed_by)
    VALUES (v_org, v_room.branch_id, _room, 'occupancy_status', v_room.occupancy_status, _occupancy_status,
            COALESCE(_reason,'') || ' [' || _source_module || COALESCE(':'||_reference::text,'') || ']', auth.uid());
    UPDATE rooms SET occupancy_status = _occupancy_status, updated_at = now() WHERE id = _room;
  END IF;

  SELECT * INTO v_room FROM rooms WHERE id = _room;
  RETURN jsonb_build_object('room_id', _room, 'ok', true,
    'housekeeping_status', v_room.housekeeping_status,
    'maintenance_status', v_room.maintenance_status,
    'occupancy_status', v_room.occupancy_status,
    'room_condition', v_room.room_condition,
    'sellable', v_room.sellable);
END $function$;