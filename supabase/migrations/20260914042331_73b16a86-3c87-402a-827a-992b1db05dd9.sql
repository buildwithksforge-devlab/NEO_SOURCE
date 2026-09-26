-- 1. Beverage attributes on stock items (all additive, all nullable/defaulted)
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS container_type text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS tracking_method text NOT NULL DEFAULT 'whole',
  ADD COLUMN IF NOT EXISTS may_open_for_pours boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_pour_ml numeric;

DO $$ BEGIN
  ALTER TABLE public.stock_items
    ADD CONSTRAINT stock_items_container_type_chk
    CHECK (container_type IN ('bottle','can','carton','keg','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.stock_items
    ADD CONSTRAINT stock_items_tracking_method_chk
    CHECK (tracking_method IN ('whole','volume','both'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Open-container volume, held separately from sealed containers
CREATE TABLE IF NOT EXISTS public.stock_open_containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  open_volume_ml numeric NOT NULL DEFAULT 0 CHECK (open_volume_ml >= 0),
  containers_open integer NOT NULL DEFAULT 0 CHECK (containers_open >= 0),
  last_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stock_item_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_open_containers TO authenticated;
GRANT ALL ON public.stock_open_containers TO service_role;
ALTER TABLE public.stock_open_containers ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_open_containers_read ON public.stock_open_containers
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.can_read_stock());

CREATE POLICY stock_open_containers_write ON public.stock_open_containers
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('inventory','stock.manage'))
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('inventory','stock.manage'));

-- 3. Every opening and pour, with its reason and source document
CREATE TABLE IF NOT EXISTS public.stock_container_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  stock_item_id uuid NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('open','pour','return','adjust','close')),
  containers_delta numeric NOT NULL DEFAULT 0,
  volume_delta_ml numeric NOT NULL DEFAULT 0,
  open_volume_after_ml numeric NOT NULL DEFAULT 0,
  reason_code text,
  reason text,
  reference_type text,
  reference_id uuid,
  stock_movement_id uuid,
  idempotency_key text,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS stock_container_events_item_idx
  ON public.stock_container_events (stock_item_id, location_id, created_at DESC);

GRANT SELECT, INSERT ON public.stock_container_events TO authenticated;
GRANT ALL ON public.stock_container_events TO service_role;
ALTER TABLE public.stock_container_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY stock_container_events_read ON public.stock_container_events
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.can_read_stock());

CREATE POLICY stock_container_events_write ON public.stock_container_events
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.has_permission('inventory','stock.manage'));

-- 4. Open one sealed container into pourable volume
CREATE OR REPLACE FUNCTION public.inventory_open_container(
  _item uuid, _location uuid, _reason text DEFAULT NULL,
  _reference_type text DEFAULT NULL, _reference_id uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_item record; v_row record; v_move uuid; v_existing record;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM stock_container_events
     WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('status','already-recorded','event_id',v_existing.id);
    END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;
  IF NOT COALESCE(v_item.may_open_for_pours, false) THEN
    RAISE EXCEPTION 'Item % is not configured to be opened for pours', v_item.name USING ERRCODE = 'data_exception';
  END IF;
  IF COALESCE(v_item.container_volume_ml, 0) <= 0 THEN
    RAISE EXCEPTION 'Item % has no container volume recorded', v_item.name USING ERRCODE = 'data_exception';
  END IF;

  v_move := inventory_apply_movement(
    _item, _location, -1, v_item.base_unit, 'consumption',
    v_item.average_cost, COALESCE(_reference_type,'container_open'), _reference_id,
    COALESCE(_reason, 'Bottle opened for pouring'),
    COALESCE(_idempotency_key, 'open:' || gen_random_uuid()::text), NULL, NULL);

  INSERT INTO stock_open_containers (organization_id, branch_id, stock_item_id, location_id)
  VALUES (v_org, v_item.branch_id, _item, _location)
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  UPDATE stock_open_containers
     SET open_volume_ml = open_volume_ml + v_item.container_volume_ml,
         containers_open = containers_open + 1,
         last_opened_at = now(),
         updated_at = now()
   WHERE stock_item_id = _item AND location_id = _location
   RETURNING * INTO v_row;

  INSERT INTO stock_container_events (organization_id, branch_id, stock_item_id, location_id,
    event_type, containers_delta, volume_delta_ml, open_volume_after_ml, reason_code, reason,
    reference_type, reference_id, stock_movement_id, idempotency_key, performed_by)
  VALUES (v_org, v_item.branch_id, _item, _location, 'open', -1, v_item.container_volume_ml,
    v_row.open_volume_ml, 'bottle-opened', COALESCE(_reason,'Bottle opened for pouring'),
    _reference_type, _reference_id, v_move, _idempotency_key, auth.uid());

  RETURN jsonb_build_object('status','opened','open_volume_ml', v_row.open_volume_ml,
                            'containers_open', v_row.containers_open, 'movement_id', v_move);
END;
$$;

-- 5. Consume millilitres, opening further containers as required
CREATE OR REPLACE FUNCTION public.inventory_consume_volume(
  _item uuid, _location uuid, _ml numeric, _reason text DEFAULT NULL,
  _reason_code text DEFAULT 'pour',
  _reference_type text DEFAULT NULL, _reference_id uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_item record; v_row record; v_existing record;
  v_needed numeric; v_opened integer := 0; v_guard integer := 0;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF COALESCE(_ml,0) <= 0 THEN RAISE EXCEPTION 'Pour volume must be greater than zero'; END IF;

  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM stock_container_events
     WHERE organization_id = v_org AND idempotency_key = _idempotency_key;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('status','already-recorded','event_id',v_existing.id);
    END IF;
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;
  IF COALESCE(v_item.container_volume_ml,0) <= 0 THEN
    RAISE EXCEPTION 'Item % has no container volume recorded', v_item.name USING ERRCODE = 'data_exception';
  END IF;

  INSERT INTO stock_open_containers (organization_id, branch_id, stock_item_id, location_id)
  VALUES (v_org, v_item.branch_id, _item, _location)
  ON CONFLICT (stock_item_id, location_id) DO NOTHING;

  SELECT * INTO v_row FROM stock_open_containers
   WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;

  v_needed := _ml;
  WHILE v_row.open_volume_ml < v_needed LOOP
    v_guard := v_guard + 1;
    IF v_guard > 100 THEN
      RAISE EXCEPTION 'Pour of % ml would need too many containers', _ml USING ERRCODE = 'data_exception';
    END IF;
    PERFORM inventory_open_container(
      _item, _location,
      'Opened automatically to complete a ' || trim(to_char(_ml,'FM999999990.###')) || ' ml pour',
      COALESCE(_reference_type,'auto_open'), _reference_id,
      CASE WHEN _idempotency_key IS NULL THEN NULL
           ELSE _idempotency_key || ':open:' || v_guard::text END);
    v_opened := v_opened + 1;
    SELECT * INTO v_row FROM stock_open_containers
     WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;
  END LOOP;

  UPDATE stock_open_containers
     SET open_volume_ml = open_volume_ml - v_needed,
         containers_open = CASE WHEN open_volume_ml - v_needed <= 0 THEN 0 ELSE containers_open END,
         updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  INSERT INTO stock_container_events (organization_id, branch_id, stock_item_id, location_id,
    event_type, containers_delta, volume_delta_ml, open_volume_after_ml, reason_code, reason,
    reference_type, reference_id, idempotency_key, performed_by)
  VALUES (v_org, v_item.branch_id, _item, _location, 'pour', 0, -v_needed,
    v_row.open_volume_ml, COALESCE(_reason_code,'pour'), _reason,
    _reference_type, _reference_id, _idempotency_key, auth.uid());

  RETURN jsonb_build_object('status','poured','ml', v_needed,
                            'containers_opened', v_opened,
                            'open_volume_ml', v_row.open_volume_ml);
END;
$$;

-- 6. One controlled usage entry for every non-sale consumption
CREATE OR REPLACE FUNCTION public.inventory_record_usage(
  _item uuid, _location uuid, _quantity numeric, _unit text,
  _reason_code text, _reason text DEFAULT NULL,
  _reference_type text DEFAULT NULL, _reference_id uuid DEFAULT NULL,
  _idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_item record; v_actor text; v_note text; v_move uuid; v_unit text := lower(COALESCE(_unit,''));
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organization'; END IF;
  IF NOT has_permission('inventory','stock.manage') THEN
    RAISE EXCEPTION 'Not permitted to record stock usage';
  END IF;
  IF _reason_code IS NULL OR btrim(_reason_code) = '' THEN
    RAISE EXCEPTION 'A reason is required for every stock usage entry' USING ERRCODE = 'data_exception';
  END IF;
  IF _reason_code NOT IN ('requisition','transfer','bottle-open','breakage','spillage',
                          'complimentary','staff-consumption','expiry','event-consumption',
                          'manual-issue','count-variance') THEN
    RAISE EXCEPTION 'Unknown usage reason %', _reason_code USING ERRCODE = 'data_exception';
  END IF;
  IF COALESCE(_quantity,0) <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero' USING ERRCODE = 'data_exception';
  END IF;

  SELECT * INTO v_item FROM stock_items WHERE id = _item AND organization_id = v_org;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Unknown stock item'; END IF;

  SELECT COALESCE(p.full_name, p.email) INTO v_actor FROM profiles p WHERE p.id = auth.uid();
  v_note := replace(initcap(replace(_reason_code,'-',' ')),'  ',' ')
            || CASE WHEN _reason IS NOT NULL THEN ' · ' || _reason ELSE '' END
            || CASE WHEN v_actor IS NOT NULL THEN ' · recorded by ' || v_actor ELSE '' END;

  IF _reason_code = 'bottle-open' THEN
    RETURN inventory_open_container(_item, _location, v_note, _reference_type, _reference_id, _idempotency_key);
  END IF;

  IF v_unit IN ('ml','millilitre','millilitres','cl','l','litre','litres')
     AND COALESCE(v_item.tracking_method,'whole') IN ('volume','both')
     AND COALESCE(v_item.container_volume_ml,0) > 0 THEN
    RETURN inventory_consume_volume(
      _item, _location,
      _quantity * CASE v_unit WHEN 'cl' THEN 10
                              WHEN 'l' THEN 1000 WHEN 'litre' THEN 1000 WHEN 'litres' THEN 1000
                              ELSE 1 END,
      v_note, _reason_code, _reference_type, _reference_id, _idempotency_key);
  END IF;

  v_move := inventory_apply_movement(
    _item, _location, -_quantity, COALESCE(_unit, v_item.base_unit),
    CASE _reason_code WHEN 'breakage' THEN 'damage' WHEN 'expiry' THEN 'expiry'
                      WHEN 'transfer' THEN 'transfer' ELSE 'consumption' END,
    v_item.average_cost, COALESCE(_reference_type, _reason_code), _reference_id,
    v_note, _idempotency_key, NULL, NULL);

  RETURN jsonb_build_object('status','recorded','movement_id', v_move, 'reason_code', _reason_code);
END;
$$;
