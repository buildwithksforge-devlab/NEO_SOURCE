CREATE POLICY pos_order_items_kitchen_production_read
  ON public.pos_order_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.station_ticket_items sti
    JOIN public.station_tickets t ON t.id = sti.ticket_id
    WHERE sti.order_item_id = pos_order_items.id
      AND t.organization_id = public.current_org_id()
      AND public.has_permission('kitchen'::text, 'queue'::text, 'view'::text)
      AND t.station_id = ANY (public.neo_kitchen_visible_station_ids())
  ));

CREATE POLICY pos_order_item_modifiers_kitchen_production_read
  ON public.pos_order_item_modifiers FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.station_ticket_items sti
    JOIN public.station_tickets t ON t.id = sti.ticket_id
    WHERE sti.order_item_id = pos_order_item_modifiers.order_item_id
      AND t.organization_id = public.current_org_id()
      AND public.has_permission('kitchen'::text, 'queue'::text, 'view'::text)
      AND t.station_id = ANY (public.neo_kitchen_visible_station_ids())
  ));