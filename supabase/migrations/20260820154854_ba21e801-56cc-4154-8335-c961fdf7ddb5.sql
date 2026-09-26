
CREATE TEMP TABLE conveyor_proof(step_no int, step text, housekeeping text, condition text, sellable boolean);

DO $$
DECLARE _org uuid; _branch uuid; _room uuid; _resv uuid; _job uuid; _rt uuid; _cust uuid;
        _hk text; _cond text; _sell boolean;
  PROCEDURE_NOOP boolean;
BEGIN
  SET LOCAL neo.internal = 'on';
  SELECT organization_id, id INTO _org, _branch FROM branches ORDER BY created_at LIMIT 1;
  SELECT id INTO _rt FROM room_types WHERE organization_id = _org LIMIT 1;

  INSERT INTO rooms (organization_id, branch_id, room_number, room_type_id, housekeeping_status, occupancy_status, status)
  VALUES (_org, _branch, 'ZZ-CONVEYOR-PROOF', _rt, 'clean', 'vacant', 'active')
  RETURNING id, housekeeping_status, room_condition, sellable INTO _room, _hk, _cond, _sell;
  INSERT INTO conveyor_proof VALUES (1, 'Vacant clean room', _hk, _cond, _sell);

  INSERT INTO reservations (organization_id, branch_id, confirmation_number, arrival_date, departure_date,
                            nights, adults, room_id, room_type_id, status)
  VALUES (_org, _branch, 'ZZ-PROOF-' || substr(gen_random_uuid()::text,1,8), current_date - 1, current_date,
          1, 1, _room, _rt, 'checked-in')
  RETURNING id INTO _resv;

  UPDATE rooms SET occupancy_status = 'occupied' WHERE id = _room;
  UPDATE reservations SET status = 'checked-out' WHERE id = _resv;

  SELECT housekeeping_status, room_condition, sellable INTO _hk, _cond, _sell FROM rooms WHERE id = _room;
  INSERT INTO conveyor_proof VALUES (2, 'After checkout', _hk, _cond, _sell);

  SELECT id INTO _job FROM housekeeping_jobs WHERE reservation_id = _resv LIMIT 1;
  IF _job IS NULL THEN RAISE EXCEPTION 'Conveyor broken: no housekeeping job raised at checkout'; END IF;
  INSERT INTO conveyor_proof VALUES (3, 'Housekeeping job raised', 'pending', 'job ' || _job::text, false);

  UPDATE housekeeping_jobs SET status = 'in-progress' WHERE id = _job;
  SELECT housekeeping_status, room_condition, sellable INTO _hk, _cond, _sell FROM rooms WHERE id = _room;
  INSERT INTO conveyor_proof VALUES (4, 'Cleaning in progress', _hk, _cond, _sell);

  UPDATE housekeeping_jobs SET status = 'completed', completed_at = now() WHERE id = _job;
  SELECT housekeeping_status, room_condition, sellable INTO _hk, _cond, _sell FROM rooms WHERE id = _room;
  INSERT INTO conveyor_proof VALUES (5, 'Cleaned, awaiting inspection', _hk, _cond, _sell);

  UPDATE housekeeping_jobs SET inspection_status = 'failed' WHERE id = _job;
  SELECT housekeeping_status, room_condition, sellable INTO _hk, _cond, _sell FROM rooms WHERE id = _room;
  INSERT INTO conveyor_proof VALUES (6, 'Inspection failed', _hk, _cond, _sell);

  UPDATE housekeeping_jobs SET inspection_status = 'passed' WHERE id = _job;
  SELECT housekeeping_status, room_condition, sellable INTO _hk, _cond, _sell FROM rooms WHERE id = _room;
  INSERT INTO conveyor_proof VALUES (7, 'Inspection passed — sellable', _hk, _cond, _sell);

  IF NOT _sell THEN RAISE EXCEPTION 'Conveyor broken: room did not become sellable after inspection'; END IF;

  DELETE FROM notifications WHERE source_record_id IN (_job);
  DELETE FROM housekeeping_jobs WHERE id = _job;
  DELETE FROM reservations WHERE id = _resv;
  DELETE FROM rooms WHERE id = _room;
END $$;

SELECT * FROM conveyor_proof ORDER BY step_no;
