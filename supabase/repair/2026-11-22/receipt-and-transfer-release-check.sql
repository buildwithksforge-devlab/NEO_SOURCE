-- Read-only installation check for Guest receipts, transfers, tax documents and displays.
WITH expected(feature, signature, required_markers, anonymous_expected) AS (VALUES
  ('Guest order receipts', 'public.neo_guest_order_tracking(uuid,text)', ARRAY['neo_guest_delivery_receipt_v1','AND customer_id = _cust'], false),
  ('Guest receipt PDF evidence', 'public.neo_guest_folio_projection(uuid,uuid)', ARRAY['''status'', p.status','fo.customer_id = _cust AND fo.branch_id = _branch'], false),
  ('Guest transfer retry', 'public.neo_guest_request_transport(uuid,uuid,uuid,timestamptz,text,text,integer,integer,text,text,uuid)', ARRAY['pg_advisory_xact_lock','guest_request_key'], false),
  ('Staff transfer actions', 'public.neo_transport_set_status(uuid,text,uuid,numeric,text)', ARRAY['already_saved','Choose an eligible driver for this property'], false),
  ('Staff transfer rider picker', 'public.neo_transport_rider_candidates(uuid)', ARRAY['in_my_branch_scope','''requests'', ''edit'''], false),
  ('Folio tax breakdown', 'public.neo_folio_document_tax_rows(uuid,uuid)', ARRAY['neo_pos_sales_tax_receipt','Other recorded tax'], false),
  ('Staff document tax hooks', 'public.neo_document_payload(text,uuid)', ARRAY['neo_lpo_document_tax_totals','neo_pos_sales_tax_receipt'], false),
  ('Supplier purchase order tax', 'public.neo_partner_lpo_payload(uuid,uuid,text)', ARRAY['neo_lpo_document_tax_totals','r.auth_user_id=auth.uid()'], false),
  ('Display PIN setup', 'public.neo_station_display_pin_admin(uuid,uuid,uuid,text)', ARRAY['neo_station_entry_pins','neo_station_login_admin'], false),
  ('Paired display PIN entry', 'public.neo_production_display_entry(text,text)', ARRAY['neo_production_paired_session','neo_production_display_entry_ready'], true),
  ('Display supervisor approval', 'public.neo_production_display_supervisor(text,text,text)', ARRAY['neo_production_can_manage','neo_kitchen_visible_station_ids'], true)
), installed AS (
  SELECT e.*, p.oid, p.prosecdef, p.prosrc
  FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
)
SELECT feature, signature,
  coalesce(prosecdef AND (feature <> 'Guest receipt PDF evidence'
    OR strpos(prosrc, '''branch_id'', coalesce(p.branch_id, _branch)')>0
    OR (strpos(prosrc, '''branch_id'', p.branch_id')>0 AND strpos(prosrc, 'coalesce(pm.branch_id, _branch) AS branch_id')>0)) AND NOT EXISTS (
    SELECT 1 FROM unnest(required_markers) AS marker(value) WHERE strpos(prosrc, marker.value)=0
  ), false) AS definition_ready,
  coalesce(has_function_privilege('authenticated', oid, 'EXECUTE')
    AND has_function_privilege('anon', oid, 'EXECUTE')=anonymous_expected, false) AS permissions_ready
FROM installed ORDER BY feature;
