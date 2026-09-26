-- MAINTENANCE REPAIR: keep room sellability in lockstep with the work order,
-- regardless of whether the block was set through wo_set_block or a direct write.
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
               and (new.status in ('closed','cancelled')
                    or (new.blocks_room = false));

  if v_block then
    perform public.ops_set_room_status(
      new.room_id, null, coalesce(nullif(new.block_status,''),'out-of-order'),
      new.description, 'maintenance', new.id);
  elsif v_release then
    -- released to dirty: housekeeping must still clean/inspect before it is sellable
    perform public.ops_set_room_status(
      new.room_id, 'dirty', 'operational', 'Maintenance closed', 'maintenance', new.id);
    update public.maintenance_work_orders set blocks_room = false, block_status = null
      where id = new.id and (blocks_room or block_status is not null);
  end if;
  return new;
end $$;

revoke all on function public.neo_wo_room_block_sync() from public, anon, authenticated;

drop trigger if exists trg_wo_room_block_sync on public.maintenance_work_orders;
create trigger trg_wo_room_block_sync
  after insert or update of blocks_room, block_status, status on public.maintenance_work_orders
  for each row execute function public.neo_wo_room_block_sync();