-- Code-only installation: no existing payment, bill or stock row is rewritten.
-- Protect the amount represented by an in-flight or recorded collection.
BEGIN;
CREATE OR REPLACE FUNCTION public.neo_pos_collected_line_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  ids uuid[];
  bill_id uuid;
  bill public.pos_orders;
BEGIN
  IF TG_TABLE_NAME='pos_order_items' THEN
    -- Production/service timestamps and instructions remain editable under
    -- their existing authorization. They do not change the collected amount.
    IF TG_OP='UPDATE' AND
      (new_row - ARRAY['status','held','station_id','sent_at','ready_at','served_at','updated_at',
                        'special_instructions','allergy_note']) IS NOT DISTINCT FROM
      (old_row - ARRAY['status','held','station_id','sent_at','ready_at','served_at','updated_at',
                        'special_instructions','allergy_note']) THEN
      RETURN NEW;
    END IF;
    ids := ARRAY[nullif(old_row->>'order_id','')::uuid,
                 nullif(new_row->>'order_id','')::uuid];
  ELSE
    -- Modifier changes must follow the same parent bill lock as item changes.
    SELECT array_agg(DISTINCT i.order_id) INTO ids
    FROM public.pos_order_items i
    WHERE i.id IN (nullif(old_row->>'order_item_id','')::uuid,
                   nullif(new_row->>'order_item_id','')::uuid);
  END IF;

  FOR bill_id IN SELECT DISTINCT v FROM unnest(ids) v WHERE v IS NOT NULL ORDER BY v LOOP
    SELECT * INTO bill FROM public.pos_orders WHERE id=bill_id FOR UPDATE;
    IF bill.id IS NULL THEN CONTINUE; END IF;
    IF (nullif(new_row->>'organization_id','')::uuid IS NOT NULL
        AND (new_row->>'organization_id')::uuid IS DISTINCT FROM bill.organization_id)
       OR (nullif(old_row->>'organization_id','')::uuid IS NOT NULL
        AND (old_row->>'organization_id')::uuid IS DISTINCT FROM bill.organization_id) THEN
      RAISE EXCEPTION 'Item and bill belong to different workspaces' USING ERRCODE='42501';
    END IF;
    IF coalesce(bill.paid_total,0)>0 OR bill.status IN
       ('paid','closed','charged-to-room','credit','cancelled','voided')
       OR EXISTS (SELECT 1 FROM public.pos_payments p
          WHERE p.organization_id=bill.organization_id AND p.order_id=bill.id
            AND p.amount>0 AND p.status IN ('initiated','pending','confirmed'))
       OR EXISTS (SELECT 1 FROM public.cash_payment_requests c
          WHERE c.organization_id=bill.organization_id AND c.source_module='pos'
            AND c.source_record_id=bill.id AND c.amount>0
            AND c.status NOT IN ('cancelled','rejected','failed','expired'))
       OR EXISTS (SELECT 1 FROM public.mpesa_transactions t
          JOIN public.pos_payments p ON p.id=t.payment_id
            AND p.organization_id=t.organization_id
          WHERE p.order_id=bill.id AND t.organization_id=bill.organization_id
            AND t.payment_table='pos_payments' AND t.amount>0
            AND t.status IN ('initiated','pending','unknown','success')) THEN
      RAISE EXCEPTION
        'This bill has a pending or recorded collection. Keep its items unchanged; reconcile the existing payment or use the authorized refund/void workflow.'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_collected_line_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS neo_pos_collected_line_guard_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_collected_line_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.pos_order_items
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_collected_line_guard();
DROP TRIGGER IF EXISTS neo_pos_collected_modifier_guard_trg ON public.pos_order_item_modifiers;
CREATE TRIGGER neo_pos_collected_modifier_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.pos_order_item_modifiers
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_collected_line_guard();
COMMIT;
