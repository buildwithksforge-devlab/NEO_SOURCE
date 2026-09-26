-- Canonical, permission-gated bill discount for POS orders.
-- Totals stay owned by tg_pos_order_totals_authoritative: this routine only
-- sets discount_total after checking the configured policy boundary.
create or replace function public.neo_pos_apply_discount(
  _order uuid,
  _discount uuid,
  _reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  o public.pos_orders;
  d public.pos_discounts;
  _amount numeric(14,2);
  _cap numeric(14,2);
begin
  select * into o from public.pos_orders where id = _order;
  if o.id is null then
    raise exception 'That order could not be found.';
  end if;
  if o.organization_id <> current_org_id() then
    raise exception 'That order belongs to another workspace.';
  end if;
  if not (o.branch_id = any (current_branch_ids())) then
    raise exception 'You are not assigned to the property that owns this order.';
  end if;
  if not has_permission('pos', 'discount.execute') then
    raise exception 'You do not have permission to apply a discount to a bill.';
  end if;
  if coalesce(o.status,'draft') in ('closed','cancelled','voided') then
    raise exception 'This bill is % and can no longer be discounted.', o.status;
  end if;
  if coalesce(o.payment_status,'unpaid') = 'paid' then
    raise exception 'This bill is already paid. Use a refund, not a discount.';
  end if;

  if _discount is null then
    update public.pos_orders set discount_total = 0 where id = _order;
    perform emit_domain_event(o.organization_id, o.branch_id, 'pos.discount.cleared', 'pos',
      _order, jsonb_build_object('reason', _reason), null, null);
    return jsonb_build_object('ok', true, 'discount_total', 0);
  end if;

  select * into d from public.pos_discounts where id = _discount;
  if d.id is null or d.organization_id <> o.organization_id then
    raise exception 'That discount policy could not be found for this workspace.';
  end if;
  if d.branch_id is not null and d.branch_id <> o.branch_id then
    raise exception 'That discount policy belongs to another property.';
  end if;
  if not coalesce(d.active, false) then
    raise exception 'That discount policy is not active.';
  end if;
  if d.valid_from is not null and current_date < d.valid_from then
    raise exception 'That discount policy is not valid yet.';
  end if;
  if d.valid_to is not null and current_date > d.valid_to then
    raise exception 'That discount policy has expired.';
  end if;
  if d.order_types is not null and array_length(d.order_types, 1) is not null
     and not (o.order_type = any (d.order_types)) then
    raise exception 'That discount policy does not apply to % orders.', o.order_type;
  end if;
  if coalesce(d.requires_approval, false) and not has_permission('pos', 'discount.approve') then
    raise exception 'This discount needs approval. Ask an authorised manager to apply it.';
  end if;

  if d.discount_type = 'percentage' then
    _amount := round(coalesce(o.subtotal, 0) * coalesce(d.value, 0) / 100.0, 2);
  else
    _amount := round(coalesce(d.value, 0), 2);
  end if;

  _cap := coalesce(d.max_value, _amount);
  if _amount > _cap then
    _amount := _cap;
  end if;
  if _amount > coalesce(o.subtotal, 0) then
    _amount := coalesce(o.subtotal, 0);
  end if;

  update public.pos_orders set discount_total = _amount where id = _order;

  perform emit_domain_event(o.organization_id, o.branch_id, 'pos.discount.applied', 'pos',
    _order,
    jsonb_build_object('discount_id', d.id, 'discount_name', d.name,
                       'amount', _amount, 'capped_at', d.max_value, 'reason', _reason),
    null, null);

  return jsonb_build_object('ok', true, 'discount_total', _amount,
                            'capped', (_cap < round(case when d.discount_type='percentage'
                                then coalesce(o.subtotal,0)*coalesce(d.value,0)/100.0
                                else coalesce(d.value,0) end, 2)));
end;
$$;

revoke all on function public.neo_pos_apply_discount(uuid, uuid, text) from public;
grant execute on function public.neo_pos_apply_discount(uuid, uuid, text) to authenticated;