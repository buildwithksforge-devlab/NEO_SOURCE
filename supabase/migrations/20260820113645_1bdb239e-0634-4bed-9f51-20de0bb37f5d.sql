-- ============================================================
-- NEO — Hotel role catalogue, reporting structure and
-- restricted approval authority (additive, reversible).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.role_catalogue (
  role_key              text PRIMARY KEY,
  role_name             text NOT NULL,
  department            text NOT NULL,
  reports_to_key        text,
  multiplicity          text NOT NULL DEFAULT 'multiple',
  access_scope          text NOT NULL DEFAULT 'self',
  restricted_authority  boolean NOT NULL DEFAULT false,
  optional_role         boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  summary               text NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.role_catalogue TO authenticated;
GRANT ALL ON public.role_catalogue TO service_role;
ALTER TABLE public.role_catalogue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in staff may read the role catalogue" ON public.role_catalogue;
CREATE POLICY "Signed-in staff may read the role catalogue"
  ON public.role_catalogue FOR SELECT TO authenticated USING (true);

INSERT INTO public.role_catalogue
  (role_key, role_name, department, reports_to_key, multiplicity, access_scope, restricted_authority, optional_role, sort_order, summary)
VALUES
  ('owner','Owner','Executive Management',NULL,'single','organisation',true,false,10,
   'Complete hotel visibility. Sets strategy and policy, approves budgets, major purchases and every restricted transaction. Cannot permanently delete completed audit, financial or stock records.'),
  ('operations-manager','Operations Manager','Operations','owner','single','branch',true,false,20,
   'Runs daily hotel operations across every department, resolves escalations and approves restricted requests. Cannot change ownership or Owner-only security settings.'),
  ('finance-manager','Finance Manager','Finance','owner','single','department',false,false,30,
   'Supervises accounting, budgets, payables, receivables, statutory compliance and stock valuation. Approves normal supplier payments only — never voids, refunds, discounts or complimentary services.'),
  ('accountant','Accountant','Finance','finance-manager','multiple','team',false,false,31,
   'Posts income and expenses, processes supplier invoices, reconciles cash, bank and revenue, and matches LPOs, GRNs and invoices. Cannot approve their own work or delete posted entries.'),
  ('night-auditor','Night Auditor','Finance','finance-manager','multiple','team',false,false,32,
   'Performs end-of-day processing, verifies room charges and payments and prepares the daily revenue report. Submits corrections rather than making them.'),
  ('food-and-beverage-manager','Food and Beverage Manager','Food and Beverage','operations-manager','single','department',false,false,40,
   'Manages restaurant, bar, coffee station and room service, rosters and outlet sales. Submits restricted-action requests; cannot approve them or change selling prices.'),
  ('waiter','Waiter / Waitress','Food and Beverage','food-and-beverage-manager','multiple','self',false,false,41,
   'Serves assigned tables, takes orders, presents bills and records feedback. Sees only their own tables, orders and bills.'),
  ('barista','Barista','Food and Beverage','food-and-beverage-manager','multiple','self',false,false,42,
   'Prepares beverages to standard recipes, monitors coffee-station stock and records wastage and remakes.'),
  ('bar-attendant','Bar Attendant','Food and Beverage','food-and-beverage-manager','multiple','self',false,false,43,
   'Prepares and issues bar orders, manages approved tabs, records usage, breakages and wastage and reconciles drinks issued against sales.'),
  ('head-chef','Head Chef','Main Kitchen','operations-manager','single','department',false,false,50,
   'Leads main-kitchen production, allocates orders to stations, maintains recipes and hygiene and requests ingredients. Cannot void orders, change prices or approve complimentary food.'),
  ('hot-kitchen-chef','Hot-Kitchen Chef','Main Kitchen','head-chef','multiple','self',false,false,51,
   'Prepares assigned meals to recipe and updates order progress at their station. No access to guest billing.'),
  ('chief-steward','Chief Steward','Main Kitchen','head-chef','single','team',false,true,52,
   'Manages kitchen cleaning and sanitation, assigns stewarding duties and controls cleaning chemicals. No access to guest bills or sales.'),
  ('kitchen-steward','Kitchen Steward / Dishwasher','Main Kitchen','chief-steward','multiple','self',false,false,53,
   'Washes utensils and equipment, maintains sanitation and reports breakages.'),
  ('head-pastry-chef','Head Pastry Chef','Pastry and Bakery','operations-manager','single','department',false,false,60,
   'Plans and approves pastry, bakery and custom-cake production, assigns tasks and submits stock requisitions.'),
  ('pastry-chef','Pastry Chef','Pastry and Bakery','head-pastry-chef','multiple','self',false,false,61,
   'Prepares assigned pastry products to recipe and records usage and wastage.'),
  ('front-office-supervisor','Front Office Supervisor','Front Office','operations-manager','single','department',false,false,70,
   'Supervises reception, reservations, room allocation, folios and shift handovers. Submits discount, refund, upgrade and correction requests.'),
  ('receptionist','Receptionist','Front Office','front-office-supervisor','multiple','self',false,false,71,
   'Handles enquiries, reservations, check-in, checkout, approved charges and payments in their own cashier session.'),
  ('reservations-agent','Reservations Agent','Front Office','front-office-supervisor','multiple','self',false,true,72,
   'Manages telephone, email, website and travel-agent bookings at approved rates. Cannot independently discount or override rates.'),
  ('front-office-cashier','Front Office Cashier','Front Office','front-office-supervisor','multiple','self',false,true,73,
   'Receives guest payments, maintains floats and reconciles their own cashier shift. Cash differences are reported, never adjusted away.'),
  ('porter','Porter / Bell Attendant','Front Office','front-office-supervisor','multiple','self',false,true,74,
   'Assists with luggage, arrivals, departures and approved guest deliveries. Cannot see guest balances.'),
  ('driver','Driver / Transport Officer','Front Office','front-office-supervisor','multiple','self',false,true,75,
   'Completes guest transfers and records trip status, mileage and fuel. No access to full guest profiles or bills.'),
  ('housekeeping-supervisor','Housekeeping Supervisor','Housekeeping','operations-manager','single','department',false,false,80,
   'Assigns and inspects rooms, manages linen and amenities, plans deep cleaning and coordinates with Front Office. Cannot remove charges or give discounts.'),
  ('housekeeper','Housekeeper','Housekeeping','housekeeping-supervisor','multiple','self',false,false,81,
   'Cleans assigned rooms and public areas, records room condition, damages and lost property. Cannot see rates or balances.'),
  ('laundry-supervisor','Laundry Supervisor','Housekeeping','housekeeping-supervisor','single','team',false,true,82,
   'Manages guest laundry, linen and uniforms, controls issue and return and assigns laundry work. Cannot remove guest laundry charges.'),
  ('laundry-attendant','Laundry Attendant','Housekeeping','laundry-supervisor','multiple','self',false,false,83,
   'Processes assigned laundry batches and records items received, returned and damaged.'),
  ('maintenance-manager','Maintenance Manager','Maintenance','operations-manager','single','department',false,false,90,
   'Prioritises and assigns repair and landscaping jobs, plans preventive maintenance and maintains asset records. Cannot remove guest damage charges.'),
  ('maintenance-technician','Maintenance Technician','Maintenance','maintenance-manager','multiple','self',false,false,91,
   'Completes assigned repairs and preventive maintenance and records work and parts used.'),
  ('grounds-worker','Grounds and Landscaping Worker','Maintenance','maintenance-manager','multiple','self',false,false,92,
   'Maintains gardens, lawns and outdoor areas and records materials used. No access to guest or financial records.'),
  ('marketing-manager','Marketing Manager','Marketing','operations-manager','single','branch',false,false,100,
   'Runs marketing plans, campaigns, content, reputation and loyalty analysis using consented guest information only. Cannot activate discounted prices.'),
  ('sales-and-events-manager','Sales and Events Manager','Sales, Events and Banqueting','operations-manager','single','department',false,false,110,
   'Manages event enquiries, quotations, contracts, venues and function sheets at approved prices. Submits discount and price-override requests.'),
  ('events-coordinator','Events / Banqueting Coordinator','Sales, Events and Banqueting','sales-and-events-manager','multiple','team',false,false,111,
   'Records event requirements, prepares timelines and function sheets and coordinates departments. Cannot change contracted prices.'),
  ('banqueting-staff','Banqueting Service Staff','Sales, Events and Banqueting','events-coordinator','multiple','self',false,false,112,
   'Sets up venues, serves events and reports damages and shortages. Cannot change the event package or charges.'),
  ('procurement-manager','Procurement Manager','Procurement','operations-manager','single','department',false,false,120,
   'Compares quotations, maintains suppliers and contracts and raises LPOs. Cannot receive goods, approve their own purchases, alter GRNs or process payments.'),
  ('procurement-officer','Procurement Officer','Procurement','procurement-manager','multiple','team',false,true,121,
   'Requests quotations, prepares comparisons and drafts purchase orders. Cannot approve LPOs or record goods as received.'),
  ('storekeeper','Storekeeper','Stores and Inventory','operations-manager','multiple','department',false,false,130,
   'Receives deliveries against approved LPOs, creates GRNs, issues stock, records transfers and conducts counts. Cannot create suppliers or approve their own adjustments.'),
  ('receiving-clerk','Receiving Clerk','Stores and Inventory','storekeeper','multiple','self',false,true,131,
   'Verifies deliveries against LPOs and records shortages, excess and damage. Cannot edit LPOs or approve payment.'),
  ('human-resources-manager','Human Resources Manager','Human Resources','owner','single','department',false,false,140,
   'Manages recruitment, contracts, attendance, leave, discipline, training and payroll inputs. Cannot grant unrestricted system access or see guest bills.'),
  ('hr-officer','HR Officer','Human Resources','human-resources-manager','multiple','team',false,true,141,
   'Maintains employee documents, attendance and leave records and supports recruitment and training.'),
  ('security-supervisor','Security Supervisor','Security','operations-manager','single','department',false,false,150,
   'Manages guards, patrols, visitor and key control and incident investigation. No financial access without an approved investigation need.'),
  ('security-guard','Security Guard','Security','security-supervisor','multiple','self',false,false,151,
   'Completes patrols, registers visitors and vehicles and reports incidents and hazards.'),
  ('it-system-administrator','System Administrator','IT and Systems','owner','single','technical',false,false,160,
   'Maintains devices, networks, backups, integrations and user-access implementation. Must not see confidential business information and cannot approve purchases, payments, voids, discounts or refunds.')
ON CONFLICT (role_key) DO UPDATE SET
  role_name            = EXCLUDED.role_name,
  department           = EXCLUDED.department,
  reports_to_key       = EXCLUDED.reports_to_key,
  multiplicity         = EXCLUDED.multiplicity,
  access_scope         = EXCLUDED.access_scope,
  restricted_authority = EXCLUDED.restricted_authority,
  optional_role        = EXCLUDED.optional_role,
  sort_order           = EXCLUDED.sort_order,
  summary              = EXCLUDED.summary,
  updated_at           = now();

-- ------------------------------------------------------------
-- Restricted-action registry
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restricted_actions (
  module text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  PRIMARY KEY (module, action)
);

GRANT SELECT ON public.restricted_actions TO authenticated;
GRANT ALL ON public.restricted_actions TO service_role;
ALTER TABLE public.restricted_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in staff may read restricted actions" ON public.restricted_actions;
CREATE POLICY "Signed-in staff may read restricted actions"
  ON public.restricted_actions FOR SELECT TO authenticated USING (true);

INSERT INTO public.restricted_actions (module, action, reason) VALUES
  ('pos','voids.approve','Void'),
  ('pos','discounts.approve','Discount'),
  ('pos','complimentary.approve','Complimentary'),
  ('pos','refunds.approve','Guest refund'),
  ('pos','bills.reopen','Reopening a closed bill'),
  ('pos','pricing.manage','Price override'),
  ('pms','rate_override.approve','Price override'),
  ('pms','refunds.approve','Guest refund'),
  ('pms','complimentary.approve','Complimentary'),
  ('pms','folios.reopen','Reopening a closed folio'),
  ('pms','folios.adjust','Removing a posted guest charge'),
  ('finance-payments','refund_payment','Guest refund'),
  ('finance-payments','reverse_payment','Reversing a payment'),
  ('delivery','payments.refund-approve','Guest refund'),
  ('kitchen','void','Void'),
  ('restaurant','void','Void'),
  ('bar','void','Void'),
  ('front-office','void','Void'),
  ('finance','void','Void'),
  ('events','void','Void'),
  ('laundry','void','Void'),
  ('housekeeping','void','Void'),
  ('maintenance','void','Void'),
  ('stores','void','Void'),
  ('procurement','void','Void'),
  ('marketing','void','Void'),
  ('reports','void','Void'),
  ('human-resources','void','Void'),
  ('administration','void','Void'),
  ('kitchen','refund','Guest refund'),
  ('restaurant','refund','Guest refund'),
  ('bar','refund','Guest refund'),
  ('front-office','refund','Guest refund'),
  ('finance','refund','Guest refund'),
  ('events','refund','Guest refund'),
  ('laundry','refund','Guest refund'),
  ('housekeeping','refund','Guest refund'),
  ('maintenance','refund','Guest refund'),
  ('stores','refund','Guest refund'),
  ('procurement','refund','Guest refund'),
  ('marketing','refund','Guest refund'),
  ('reports','refund','Guest refund'),
  ('human-resources','refund','Guest refund'),
  ('administration','refund','Guest refund'),
  ('restaurant','override','Price override'),
  ('bar','override','Price override'),
  ('front-office','override','Price override'),
  ('kitchen','override','Price override'),
  ('events','override','Price override'),
  ('laundry','override','Price override'),
  ('housekeeping','override','Price override'),
  ('delivery','orders.override','Price override'),
  ('delivery','override','Price override')
ON CONFLICT (module, action) DO UPDATE SET reason = EXCLUDED.reason;

CREATE OR REPLACE FUNCTION public.is_restricted_action(_module text, _action text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restricted_actions ra
    WHERE ra.module = _module AND ra.action = _action
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_restricted_action(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_restricted_action(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_restricted_action(text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Permission templates derived from the document
-- ------------------------------------------------------------
DELETE FROM public.role_permission_templates
 WHERE template_key IN (SELECT role_key FROM public.role_catalogue);

WITH grants(k, m, acts) AS (
  VALUES
  ('operations-manager','approvals', ARRAY['view','create','approve','reject']),
  ('operations-manager','pos', ARRAY['access','orders.view','orders.create','orders.edit_draft','orders.send','orders.hold','orders.cancel_item','orders.transfer','bills.view','bills.split','bills.merge','bills.transfer','bills.reopen','voids.request','voids.approve','discounts.request','discounts.approve','complimentary.request','complimentary.approve','refunds.request','refunds.approve','pricing.manage','menu.view','menu.manage','tables.view','tables.manage','kds.view','kds.manage','payments.view','payments.process','payments.verify','receipts.print','receipts.reprint','reports.view','reports.export','shifts.open','shifts.close','shifts.review','room_charge.post','settings.manage']),
  ('operations-manager','pms', ARRAY['dashboard.view','availability.view','reservations.view','reservations.create','reservations.edit','reservations.confirm','reservations.cancel','reservations.mark_no_show','reservations.reinstate','rooms.view','rooms.assign','rooms.block','rooms.transfer','rooms.upgrade','checkin.perform','checkout.perform','folios.view','folios.create','folios.post_charge','folios.split','folios.close','folios.reopen','folios.adjust','payments.record','rate_override.request','rate_override.approve','refunds.request','refunds.approve','complimentary.request','complimentary.approve','groups.manage','corporate.manage','ota.view','reports.view','reports.export','write']),
  ('operations-manager','front-office', ARRAY['view','create','edit','approve','reject','override','void','refund','export','print']),
  ('operations-manager','restaurant', ARRAY['view','create','edit','approve','reject','override','void','refund','export','print']),
  ('operations-manager','bar', ARRAY['view','create','edit','approve','reject','override','void','refund','export','print']),
  ('operations-manager','kitchen', ARRAY['access','view','queue.view','all_stations.view','ticket.accept','ticket.prioritize','chef.assign','item.prepare','item.ready','item.reassign','item.cancel_request','recipes.view','recipes.create','recipes.edit','recipes.approve','portions.view','menu_availability.manage','production.manage','station.manage','waste.view','waste.record','waste.approve','quality.approve','quality.complete','quality_hold.create','quality_hold.release','delay.report','reports.view','reports.export','approve','reject','override','void','refund','settings.manage']),
  ('operations-manager','housekeeping', ARRAY['view','board.view','assigned.view','create','edit','assign','inspect','inspection.fail','room.ready','cleaning.start','cleaning.complete','deep-clean.manage','turndown.manage','lost-found.manage','guest-requests.manage','reports.view','reports.export','approve','reject','override','void','refund']),
  ('operations-manager','laundry', ARRAY['view','create','edit','orders.create','status.update','collect','deliver','complete','linen.manage','linen.approve','hotel.manage','damage.report','charge.post','reports.view','approve','reject','override','void','refund','print','export']),
  ('operations-manager','maintenance', ARRAY['view','create','edit','work-orders.view','work-orders.create','work-orders.assign','work-orders.accept','work-orders.update','work-orders.complete','work-orders.verify','work-orders.reopen','preventive.manage','assets.manage','assets.transfer','parts.request','costs.view','room.block','room.release','reports.view','approve','reject','override','void','refund','print','export']),
  ('operations-manager','events', ARRAY['view','create','edit','quote','confirm','beo','readiness','cost','financials','approve','reject','override','void','refund','print','export']),
  ('operations-manager','delivery', ARRAY['access','view','orders.view','orders.accept','orders.reject','orders.update','orders.cancel','orders.financials','orders.override','dispatch.view','dispatch.assign','dispatch.reassign','payments.view','payments.refund-request','payments.refund-approve','payments.revenue','reports.view','reports.export','approve','reject','override','void','refund']),
  ('operations-manager','stores', ARRAY['view','create','edit','requisition.view-all','requisition.create','requisition.submit','requisition.review','requisition.approve','requisition.issue','requisition.receive','requisition.partial','requisition.cancel','requisition.discrepancy','consumption.view','consumption.record','mini-store.manage','approve','reject','override','export','print']),
  ('operations-manager','procurement', ARRAY['view','dashboard.view','create','edit','requests.manage','requests.approve','orders.manage','orders.approve','receiving.manage','suppliers.manage','invoices.manage','reports.view','approve','reject','export','print']),
  ('operations-manager','inventory', ARRAY['dashboard.view','items.manage','stock.manage','stocktake.manage','transfers.manage','adjustments.manage','adjustments.approve','costing.view','reports.view']),
  ('operations-manager','marketing', ARRAY['view','export','print']),
  ('operations-manager','analytics', ARRAY['view','export','print']),
  ('operations-manager','reports', ARRAY['view','export','print']),
  ('operations-manager','audit_logs', ARRAY['view','export']),
  ('operations-manager','hr-employees', ARRAY['directory.view','profile.view']),
  ('operations-manager','hr-attendance', ARRAY['all.view','team.view','correct','correction.approve']),
  ('operations-manager','hr-leave', ARRAY['team.view','approve']),
  ('operations-manager','hr-scheduling', ARRAY['team.view','roster.create','roster.publish','roster.approve','overtime.approve','swap.approve']),
  ('operations-manager','hr-performance', ARRAY['review.create','review.conduct','reports.view']),
  ('operations-manager','crm-customers', ARRAY['view']),
  ('operations-manager','crm-feedback', ARRAY['view','edit']),
  ('operations-manager','finance-reports', ARRAY['view','print','export']),
  ('operations-manager','dashboards', ARRAY['view','customize','export']),
  ('operations-manager','executive-dashboard', ARRAY['view']),
  ('operations-manager','kpis', ARRAY['view']),
  ('operations-manager','alerts', ARRAY['view','manage']),
  ('operations-manager','ai-insights', ARRAY['view','generate']),
  ('operations-manager','quality', ARRAY['view','create','edit','approve','export']),
  ('operations-manager','departments', ARRAY['view']),
  ('operations-manager','stations', ARRAY['view']),
  ('operations-manager','users', ARRAY['view']),

  ('finance-manager','finance', ARRAY['view','create','edit','approve','reject','export','print']),
  ('finance-manager','finance-gl', ARRAY['view','create_journal','approve_journal','post_journal','reverse_journal','manage_accounts','close_period']),
  ('finance-manager','finance-ap', ARRAY['view','record_supplier_invoice','approve_supplier_invoice','schedule_payment','approve_payment','record_payment','approve_match_variance']),
  ('finance-manager','finance-ar', ARRAY['view','create_statement','allocate_receipt','approve_credit','change_credit_limit','create_credit_application','record_collection_note','request_write_off','approve_write_off']),
  ('finance-manager','finance-tax', ARRAY['view','view_compliance','configure','submit_etims','retry_etims','issue_credit_note']),
  ('finance-manager','finance-reports', ARRAY['view','print','export','view_costs','view_profit']),
  ('finance-manager','finance-payments', ARRAY['reconcile','approve_cash_variance']),
  ('finance-manager','procurement', ARRAY['view','dashboard.view','invoices.manage','reports.view','orders.approve','requests.approve','approve']),
  ('finance-manager','inventory', ARRAY['dashboard.view','costing.view','reports.view','adjustments.approve']),
  ('finance-manager','stores', ARRAY['view','requisition.view-all','consumption.view','export']),
  ('finance-manager','pos', ARRAY['reports.view','reports.export','payments.view']),
  ('finance-manager','pms', ARRAY['reports.view','reports.export','folios.view']),
  ('finance-manager','crm-credit', ARRAY['view','create','approve']),
  ('finance-manager','crm-corporate', ARRAY['view','edit']),
  ('finance-manager','analytics', ARRAY['view','export']),
  ('finance-manager','reports', ARRAY['view','export','print']),
  ('finance-manager','audit_logs', ARRAY['view','export']),
  ('finance-manager','hr-payroll', ARRAY['inputs.view','labour_cost.view','export']),
  ('finance-manager','approvals', ARRAY['view','create','approve','reject']),
  ('finance-manager','dashboards', ARRAY['view','customize','export']),

  ('accountant','finance', ARRAY['view','create','edit','export','print']),
  ('accountant','finance-gl', ARRAY['view','create_journal']),
  ('accountant','finance-ap', ARRAY['view','record_supplier_invoice','schedule_payment','record_payment']),
  ('accountant','finance-ar', ARRAY['view','create_statement','allocate_receipt','create_credit_application','record_collection_note','request_write_off']),
  ('accountant','finance-tax', ARRAY['view','view_compliance','submit_etims']),
  ('accountant','finance-reports', ARRAY['view','print','export','view_costs']),
  ('accountant','procurement', ARRAY['view','invoices.manage','reports.view']),
  ('accountant','inventory', ARRAY['costing.view','reports.view']),
  ('accountant','stores', ARRAY['view','consumption.view']),
  ('accountant','pos', ARRAY['reports.view','payments.view']),
  ('accountant','pms', ARRAY['reports.view','folios.view']),
  ('accountant','reports', ARRAY['view','export']),

  ('night-auditor','pms', ARRAY['dashboard.view','reservations.view','rooms.view','folios.view','payments.record','reports.view','reports.export']),
  ('night-auditor','pos', ARRAY['reports.view','reports.export','payments.view','bills.view']),
  ('night-auditor','finance-gl', ARRAY['view']),
  ('night-auditor','finance-reports', ARRAY['view','print','export']),
  ('night-auditor','finance-payments', ARRAY['reconcile']),
  ('night-auditor','reports', ARRAY['view','export','print']),
  ('night-auditor','audit_logs', ARRAY['view']),

  ('food-and-beverage-manager','pos', ARRAY['access','orders.view','orders.create','orders.edit_draft','orders.send','orders.hold','orders.transfer','bills.view','bills.split','bills.merge','bills.transfer','voids.request','discounts.request','complimentary.request','refunds.request','menu.view','tables.view','tables.manage','kds.view','payments.view','payments.process','payments.verify','receipts.print','receipts.reprint','reports.view','reports.export','shifts.open','shifts.close','shifts.review','room_charge.post']),
  ('food-and-beverage-manager','restaurant', ARRAY['view','create','edit','export','print']),
  ('food-and-beverage-manager','bar', ARRAY['view','create','edit','export','print']),
  ('food-and-beverage-manager','kitchen', ARRAY['access','view','queue.view','all_stations.view','recipes.view','portions.view','menu_availability.manage','reports.view']),
  ('food-and-beverage-manager','stores', ARRAY['view','requisition.view-all','requisition.create','requisition.submit','requisition.receive','consumption.view','consumption.record','mini-store.manage']),
  ('food-and-beverage-manager','inventory', ARRAY['dashboard.view','reports.view']),
  ('food-and-beverage-manager','hr-scheduling', ARRAY['team.view','roster.create','roster.publish','swap.approve']),
  ('food-and-beverage-manager','hr-attendance', ARRAY['team.view']),
  ('food-and-beverage-manager','hr-performance', ARRAY['review.create','review.conduct','reports.view']),
  ('food-and-beverage-manager','crm-feedback', ARRAY['view','edit']),
  ('food-and-beverage-manager','approvals', ARRAY['view','create']),
  ('food-and-beverage-manager','reports', ARRAY['view','export']),
  ('food-and-beverage-manager','dashboards', ARRAY['view','customize']),

  ('waiter','pos', ARRAY['access','orders.view','orders.create','orders.edit_draft','orders.send','orders.hold','bills.view','bills.split','bills.transfer','bills.merge','voids.request','discounts.request','complimentary.request','refunds.request','menu.view','tables.view','payments.process','payments.view','receipts.print','room_charge.post','shifts.open','shifts.close']),
  ('waiter','restaurant', ARRAY['view','create']),
  ('waiter','kitchen', ARRAY['queue.view']),
  ('waiter','crm-feedback', ARRAY['view','edit']),

  ('barista','pos', ARRAY['access','orders.view','menu.view','kds.view']),
  ('barista','kitchen', ARRAY['access','queue.view','ticket.accept','item.prepare','item.ready','recipes.view','portions.view','waste.record','delay.report','ingredient_request.create','ingredient_request.view','clarification.request','item.cancel_request']),
  ('barista','stores', ARRAY['requisition.create','requisition.submit','requisition.receive','consumption.record']),

  ('bar-attendant','pos', ARRAY['access','orders.view','orders.create','orders.send','bills.view','menu.view','voids.request','complimentary.request','receipts.print']),
  ('bar-attendant','bar', ARRAY['view','create']),
  ('bar-attendant','kitchen', ARRAY['queue.view','recipes.view','waste.record']),
  ('bar-attendant','stores', ARRAY['requisition.create','requisition.submit','requisition.receive','consumption.record','consumption.view']),

  ('head-chef','kitchen', ARRAY['access','view','queue.view','all_stations.view','ticket.accept','ticket.prioritize','chef.assign','item.prepare','item.ready','item.reassign','item.cancel_request','recipes.view','recipes.create','recipes.edit','recipes.approve','portions.view','menu_availability.manage','production.manage','station.manage','waste.view','waste.record','waste.approve','quality.approve','quality.complete','quality_hold.create','quality_hold.release','delay.report','clarification.request','ingredient_request.create','ingredient_request.view','reports.view','reports.export','ai.view','ai.generate']),
  ('head-chef','pos', ARRAY['kds.view','menu.view','orders.view']),
  ('head-chef','stores', ARRAY['view','requisition.view-all','requisition.create','requisition.submit','requisition.receive','requisition.partial','consumption.view','consumption.record','mini-store.manage']),
  ('head-chef','inventory', ARRAY['dashboard.view','reports.view']),
  ('head-chef','maintenance', ARRAY['work-orders.create','work-orders.view']),
  ('head-chef','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('head-chef','hr-attendance', ARRAY['team.view']),
  ('head-chef','hr-performance', ARRAY['review.create','review.conduct']),
  ('head-chef','dashboards', ARRAY['view','customize']),

  ('hot-kitchen-chef','kitchen', ARRAY['access','queue.view','ticket.accept','item.prepare','item.ready','recipes.view','portions.view','waste.record','delay.report','clarification.request','ingredient_request.create','ingredient_request.view','item.cancel_request']),
  ('hot-kitchen-chef','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('chief-steward','kitchen', ARRAY['access','queue.view','waste.record','waste.view']),
  ('chief-steward','stores', ARRAY['requisition.create','requisition.submit','requisition.receive','consumption.record','consumption.view']),
  ('chief-steward','maintenance', ARRAY['work-orders.create','work-orders.view']),
  ('chief-steward','hr-scheduling', ARRAY['team.view','roster.create']),
  ('chief-steward','hr-attendance', ARRAY['team.view']),

  ('kitchen-steward','kitchen', ARRAY['access','waste.record']),
  ('kitchen-steward','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),
  ('kitchen-steward','maintenance', ARRAY['work-orders.create']),

  ('head-pastry-chef','kitchen', ARRAY['access','view','queue.view','all_stations.view','ticket.accept','ticket.prioritize','chef.assign','item.prepare','item.ready','item.reassign','item.cancel_request','recipes.view','recipes.create','recipes.edit','recipes.approve','portions.view','menu_availability.manage','production.manage','station.manage','waste.view','waste.record','waste.approve','quality.approve','quality.complete','delay.report','reports.view']),
  ('head-pastry-chef','pos', ARRAY['kds.view','menu.view','orders.view']),
  ('head-pastry-chef','stores', ARRAY['view','requisition.view-all','requisition.create','requisition.submit','requisition.receive','consumption.view','consumption.record']),
  ('head-pastry-chef','events', ARRAY['view','readiness']),
  ('head-pastry-chef','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('head-pastry-chef','dashboards', ARRAY['view','customize']),

  ('pastry-chef','kitchen', ARRAY['access','queue.view','ticket.accept','item.prepare','item.ready','recipes.view','portions.view','waste.record','delay.report','clarification.request','ingredient_request.create']),
  ('pastry-chef','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('front-office-supervisor','pms', ARRAY['dashboard.view','availability.view','reservations.view','reservations.create','reservations.edit','reservations.confirm','reservations.cancel','reservations.mark_no_show','reservations.reinstate','rooms.view','rooms.assign','rooms.block','rooms.transfer','rooms.upgrade','checkin.perform','checkout.perform','folios.view','folios.create','folios.post_charge','folios.split','folios.close','payments.record','rate_override.request','refunds.request','complimentary.request','groups.manage','corporate.manage','ota.view','reports.view','reports.export','write']),
  ('front-office-supervisor','front-office', ARRAY['view','create','edit','export','print']),
  ('front-office-supervisor','housekeeping', ARRAY['board.view','view','guest-requests.manage']),
  ('front-office-supervisor','laundry', ARRAY['view','orders.create','status.update']),
  ('front-office-supervisor','maintenance', ARRAY['work-orders.create','work-orders.view']),
  ('front-office-supervisor','crm-customers', ARRAY['view','create','edit']),
  ('front-office-supervisor','crm-preferences', ARRAY['view','edit']),
  ('front-office-supervisor','crm-feedback', ARRAY['view','edit']),
  ('front-office-supervisor','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('front-office-supervisor','hr-attendance', ARRAY['team.view']),
  ('front-office-supervisor','finance-payments', ARRAY['open_shift','close_shift','count_cash','receive_payment','reconcile']),
  ('front-office-supervisor','reports', ARRAY['view','export']),
  ('front-office-supervisor','dashboards', ARRAY['view','customize']),

  ('receptionist','pms', ARRAY['dashboard.view','availability.view','reservations.view','reservations.create','reservations.edit','reservations.confirm','rooms.view','rooms.assign','checkin.perform','checkout.perform','folios.view','folios.create','folios.post_charge','payments.record','rate_override.request','refunds.request','complimentary.request','reports.view']),
  ('receptionist','front-office', ARRAY['view','create','edit','print']),
  ('receptionist','crm-customers', ARRAY['view','create','edit']),
  ('receptionist','crm-preferences', ARRAY['view','edit']),
  ('receptionist','crm-feedback', ARRAY['view','edit']),
  ('receptionist','housekeeping', ARRAY['board.view','guest-requests.manage']),
  ('receptionist','laundry', ARRAY['orders.create','view']),
  ('receptionist','maintenance', ARRAY['work-orders.create']),
  ('receptionist','finance-payments', ARRAY['open_shift','close_shift','count_cash','receive_payment']),
  ('receptionist','pos', ARRAY['room_charge.post']),

  ('reservations-agent','pms', ARRAY['dashboard.view','availability.view','reservations.view','reservations.create','reservations.edit','reservations.confirm','rooms.view','rate_override.request','reports.view']),
  ('reservations-agent','front-office', ARRAY['view','create','edit']),
  ('reservations-agent','crm-customers', ARRAY['view','create','edit']),
  ('reservations-agent','crm-corporate', ARRAY['view']),

  ('front-office-cashier','pms', ARRAY['folios.view','payments.record','reports.view']),
  ('front-office-cashier','front-office', ARRAY['view','print']),
  ('front-office-cashier','finance-payments', ARRAY['open_shift','close_shift','count_cash','receive_payment','reconcile']),

  ('porter','pms', ARRAY['reservations.view','rooms.view']),
  ('porter','front-office', ARRAY['view']),
  ('porter','housekeeping', ARRAY['guest-requests.manage']),

  ('driver','pms', ARRAY['reservations.view']),
  ('driver','front-office', ARRAY['view']),
  ('driver','maintenance', ARRAY['work-orders.create','work-orders.view']),

  ('housekeeping-supervisor','housekeeping', ARRAY['view','board.view','assigned.view','create','edit','assign','inspect','inspection.fail','room.ready','cleaning.start','cleaning.complete','deep-clean.manage','turndown.manage','lost-found.manage','guest-requests.manage','reports.view','reports.export','print','export']),
  ('housekeeping-supervisor','pms', ARRAY['rooms.view','availability.view','dashboard.view']),
  ('housekeeping-supervisor','laundry', ARRAY['view','linen.manage','hotel.manage','status.update','damage.report','reports.view']),
  ('housekeeping-supervisor','maintenance', ARRAY['work-orders.create','work-orders.view']),
  ('housekeeping-supervisor','stores', ARRAY['view','requisition.view-all','requisition.create','requisition.submit','requisition.receive','consumption.view','consumption.record','mini-store.manage']),
  ('housekeeping-supervisor','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('housekeeping-supervisor','hr-attendance', ARRAY['team.view']),
  ('housekeeping-supervisor','dashboards', ARRAY['view','customize']),

  ('housekeeper','housekeeping', ARRAY['assigned.view','cleaning.start','cleaning.complete','lost-found.manage','guest-requests.manage']),
  ('housekeeper','maintenance', ARRAY['work-orders.create']),
  ('housekeeper','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('laundry-supervisor','laundry', ARRAY['view','create','edit','orders.create','status.update','collect','deliver','complete','linen.manage','hotel.manage','damage.report','reports.view','print','export']),
  ('laundry-supervisor','stores', ARRAY['view','requisition.create','requisition.submit','requisition.receive','consumption.view','consumption.record']),
  ('laundry-supervisor','hr-scheduling', ARRAY['team.view','roster.create']),

  ('laundry-attendant','laundry', ARRAY['view','status.update','collect','deliver','complete','damage.report']),
  ('laundry-attendant','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('maintenance-manager','maintenance', ARRAY['view','create','edit','work-orders.view','work-orders.create','work-orders.assign','work-orders.accept','work-orders.update','work-orders.complete','work-orders.verify','work-orders.reopen','preventive.manage','assets.manage','assets.transfer','parts.request','costs.view','room.block','room.release','reports.view','print','export']),
  ('maintenance-manager','pms', ARRAY['rooms.view','rooms.block']),
  ('maintenance-manager','housekeeping', ARRAY['board.view']),
  ('maintenance-manager','stores', ARRAY['view','requisition.view-all','requisition.create','requisition.submit','requisition.receive','consumption.view','consumption.record','mini-store.manage']),
  ('maintenance-manager','procurement', ARRAY['view','requests.manage','dashboard.view']),
  ('maintenance-manager','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('maintenance-manager','hr-attendance', ARRAY['team.view']),
  ('maintenance-manager','dashboards', ARRAY['view','customize']),

  ('maintenance-technician','maintenance', ARRAY['work-orders.view','work-orders.accept','work-orders.update','work-orders.complete','parts.request']),
  ('maintenance-technician','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('grounds-worker','maintenance', ARRAY['work-orders.view','work-orders.accept','work-orders.update','work-orders.complete']),
  ('grounds-worker','stores', ARRAY['requisition.create','requisition.submit','consumption.record']),

  ('marketing-manager','marketing', ARRAY['view','create','edit','export','print']),
  ('marketing-manager','crm-customers', ARRAY['view','create','edit','export']),
  ('marketing-manager','crm-segments', ARRAY['view','edit']),
  ('marketing-manager','crm-communications', ARRAY['view','create']),
  ('marketing-manager','crm-feedback', ARRAY['view','edit']),
  ('marketing-manager','crm-loyalty', ARRAY['view','edit']),
  ('marketing-manager','crm-preferences', ARRAY['view','edit']),
  ('marketing-manager','crm-corporate', ARRAY['view','edit']),
  ('marketing-manager','crm-ai', ARRAY['view','create']),
  ('marketing-manager','events', ARRAY['view']),
  ('marketing-manager','analytics', ARRAY['view','export']),
  ('marketing-manager','reports', ARRAY['view','export']),
  ('marketing-manager','dashboards', ARRAY['view','customize']),

  ('sales-and-events-manager','events', ARRAY['view','create','edit','quote','confirm','beo','readiness','cost','financials','print','export']),
  ('sales-and-events-manager','crm-customers', ARRAY['view','create','edit']),
  ('sales-and-events-manager','crm-corporate', ARRAY['view','edit']),
  ('sales-and-events-manager','crm-communications', ARRAY['view','create']),
  ('sales-and-events-manager','pms', ARRAY['availability.view','groups.manage','reservations.view','reservations.create','rooms.view']),
  ('sales-and-events-manager','pos', ARRAY['menu.view']),
  ('sales-and-events-manager','kitchen', ARRAY['queue.view','recipes.view']),
  ('sales-and-events-manager','hr-scheduling', ARRAY['team.view','roster.create']),
  ('sales-and-events-manager','reports', ARRAY['view','export']),
  ('sales-and-events-manager','dashboards', ARRAY['view','customize']),

  ('events-coordinator','events', ARRAY['view','create','edit','beo','readiness','print']),
  ('events-coordinator','crm-customers', ARRAY['view']),
  ('events-coordinator','pms', ARRAY['availability.view']),
  ('events-coordinator','stores', ARRAY['requisition.create','requisition.submit']),

  ('banqueting-staff','events', ARRAY['view','readiness']),
  ('banqueting-staff','pos', ARRAY['orders.view','menu.view']),

  ('procurement-manager','procurement', ARRAY['view','dashboard.view','create','edit','requests.manage','orders.manage','suppliers.manage','invoices.manage','reports.view','print','export']),
  ('procurement-manager','stores', ARRAY['view','requisition.view-all','consumption.view']),
  ('procurement-manager','inventory', ARRAY['dashboard.view','reports.view','items.manage']),
  ('procurement-manager','finance-ap', ARRAY['view']),
  ('procurement-manager','reports', ARRAY['view','export']),
  ('procurement-manager','dashboards', ARRAY['view','customize']),

  ('procurement-officer','procurement', ARRAY['view','dashboard.view','create','edit','requests.manage','reports.view','print']),
  ('procurement-officer','stores', ARRAY['view','requisition.view-all']),
  ('procurement-officer','inventory', ARRAY['dashboard.view']),

  ('storekeeper','stores', ARRAY['view','create','edit','requisition.view-all','requisition.create','requisition.submit','requisition.review','requisition.issue','requisition.receive','requisition.partial','requisition.discrepancy','requisition.export','consumption.view','consumption.record','mini-store.manage','print','export']),
  ('storekeeper','inventory', ARRAY['dashboard.view','items.manage','stock.manage','stocktake.manage','transfers.manage','adjustments.manage','reports.view']),
  ('storekeeper','procurement', ARRAY['view','receiving.manage','dashboard.view','reports.view']),
  ('storekeeper','reports', ARRAY['view','export']),
  ('storekeeper','dashboards', ARRAY['view','customize']),

  ('receiving-clerk','procurement', ARRAY['view','receiving.manage']),
  ('receiving-clerk','stores', ARRAY['view','requisition.receive','requisition.discrepancy']),
  ('receiving-clerk','inventory', ARRAY['dashboard.view']),

  ('human-resources-manager','human-resources', ARRAY['view','create','edit','export','print']),
  ('human-resources-manager','hr-employees', ARRAY['directory.view','profile.view','create','edit','documents.manage','statutory.view','compensation.view','suspend','terminate','activate']),
  ('human-resources-manager','hr-attendance', ARRAY['all.view','team.view','correct','correction.approve','configure']),
  ('human-resources-manager','hr-leave', ARRAY['team.view','approve','types.manage','balance.adjust','medical.view']),
  ('human-resources-manager','hr-payroll', ARRAY['inputs.view','inputs.edit','labour_cost.view','export']),
  ('human-resources-manager','hr-performance', ARRAY['review.create','review.conduct','review.approve','kpis.manage','disciplinary.manage','grievances.manage','reports.view']),
  ('human-resources-manager','hr-recruitment', ARRAY['vacancies.view','vacancy.create','candidates.view','candidates.manage','interview.schedule','candidate.evaluate','candidate.convert']),
  ('human-resources-manager','hr-scheduling', ARRAY['team.view','roster.create','roster.publish','roster.approve','swap.approve','overtime.approve']),
  ('human-resources-manager','hr-training', ARRAY['view','manage','assign','completion.record','certifications.manage']),
  ('human-resources-manager','hr-announcements', ARRAY['view','manage']),
  ('human-resources-manager','hr-reports', ARRAY['view','export']),
  ('human-resources-manager','users', ARRAY['view','create','invite','assign_departments','assign_branches','assign_stations']),
  ('human-resources-manager','departments', ARRAY['view']),
  ('human-resources-manager','stations', ARRAY['view']),
  ('human-resources-manager','approvals', ARRAY['view','create','approve','reject']),
  ('human-resources-manager','reports', ARRAY['view','export']),
  ('human-resources-manager','dashboards', ARRAY['view','customize']),

  ('hr-officer','human-resources', ARRAY['view','create','edit']),
  ('hr-officer','hr-employees', ARRAY['directory.view','profile.view','documents.manage']),
  ('hr-officer','hr-attendance', ARRAY['all.view','team.view','correct']),
  ('hr-officer','hr-leave', ARRAY['team.view']),
  ('hr-officer','hr-recruitment', ARRAY['vacancies.view','candidates.view','candidates.manage','interview.schedule']),
  ('hr-officer','hr-training', ARRAY['view','assign','completion.record']),
  ('hr-officer','hr-announcements', ARRAY['view']),
  ('hr-officer','hr-reports', ARRAY['view','export']),

  ('security-supervisor','quality', ARRAY['view','create','edit','export']),
  ('security-supervisor','maintenance', ARRAY['work-orders.create','work-orders.view','assets.manage']),
  ('security-supervisor','housekeeping', ARRAY['lost-found.manage','board.view']),
  ('security-supervisor','pms', ARRAY['reservations.view','rooms.view']),
  ('security-supervisor','hr-scheduling', ARRAY['team.view','roster.create','roster.publish']),
  ('security-supervisor','hr-attendance', ARRAY['team.view']),
  ('security-supervisor','dashboards', ARRAY['view','customize']),

  ('security-guard','quality', ARRAY['view','create']),
  ('security-guard','maintenance', ARRAY['work-orders.create','work-orders.view']),

  ('it-system-administrator','administration', ARRAY['view','create','edit','export']),
  ('it-system-administrator','users', ARRAY['view','create','invite','edit','suspend','assign_roles','assign_departments','assign_branches','assign_stations']),
  ('it-system-administrator','roles', ARRAY['view','manage']),
  ('it-system-administrator','permissions', ARRAY['manage']),
  ('it-system-administrator','departments', ARRAY['view','manage']),
  ('it-system-administrator','stations', ARRAY['view','manage']),
  ('it-system-administrator','settings', ARRAY['view','manage']),
  ('it-system-administrator','security', ARRAY['view','manage']),
  ('it-system-administrator','audit_logs', ARRAY['view','export']),
  ('it-system-administrator','integrations', ARRAY['view','create','edit','export']),
  ('it-system-administrator','automation', ARRAY['view','create','edit','export']),
  ('it-system-administrator','automation-providers', ARRAY['view','edit']),
  ('it-system-administrator','platform', ARRAY['view','create','edit','export']),
  ('it-system-administrator','migration', ARRAY['view','create','edit','export']),
  ('it-system-administrator','quality', ARRAY['view','create','edit','export']),
  ('it-system-administrator','support', ARRAY['view','create','edit','export']),
  ('it-system-administrator','dashboards', ARRAY['view','customize','manage-defaults'])
)
INSERT INTO public.role_permission_templates (template_key, template_name, module, action)
SELECT g.k, c.role_name, g.m, a
FROM grants g
JOIN public.role_catalogue c ON c.role_key = g.k
CROSS JOIN LATERAL unnest(g.acts) AS a
WHERE EXISTS (SELECT 1 FROM public.permissions p WHERE p.module = g.m AND p.action = a);

INSERT INTO public.role_permission_templates (template_key, template_name, module, action)
SELECT c.role_key, c.role_name, b.m, b.a
FROM public.role_catalogue c
CROSS JOIN (VALUES
  ('tasks','view'),('tasks','create'),('tasks','edit'),
  ('notifications','view'),
  ('approvals','view'),('approvals','create'),
  ('dashboards','view'),
  ('hr-attendance','self.clock'),('hr-attendance','self.view'),
  ('hr-leave','apply'),('hr-leave','self.view'),
  ('hr-scheduling','self.view'),('hr-scheduling','swap.request'),
  ('hr-performance','self.view'),
  ('hr-employees','profile.view')
) AS b(m,a)
WHERE c.role_key <> 'owner'
  AND EXISTS (SELECT 1 FROM public.permissions p WHERE p.module = b.m AND p.action = b.a)
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permission_templates t
    WHERE t.template_key = c.role_key AND t.module = b.m AND t.action = b.a
  );

INSERT INTO public.role_permission_templates (template_key, template_name, module, action)
SELECT 'owner', 'Owner', p.module, p.action FROM public.permissions p;

DELETE FROM public.role_permission_templates t
USING public.restricted_actions ra
WHERE t.module = ra.module
  AND t.action = ra.action
  AND t.template_key IN (SELECT role_key FROM public.role_catalogue)
  AND t.template_key NOT IN ('owner','operations-manager');

-- ------------------------------------------------------------
-- Provisioning
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_catalogue_roles(_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _created integer := 0;
  _granted integer := 0;
  _revoked integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO public.roles (organization_id, name, description, is_system, active, access_scope)
    SELECT _org, c.role_name, c.summary, true, true, c.access_scope
    FROM public.role_catalogue c
    ON CONFLICT (organization_id, name) DO UPDATE
      SET description  = EXCLUDED.description,
          access_scope = EXCLUDED.access_scope,
          is_system    = true,
          updated_at   = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted) INTO _created FROM ins;

  WITH added AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, r.id, p.id
    FROM public.role_catalogue c
    JOIN public.roles r ON r.organization_id = _org AND r.name = c.role_name
    JOIN public.role_permission_templates t ON t.template_key = c.role_key
    JOIN public.permissions p ON p.module = t.module AND p.action = t.action
    WHERE NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
    )
    RETURNING 1
  )
  SELECT count(*) INTO _granted FROM added;

  WITH removed AS (
    DELETE FROM public.role_permissions rp
    USING public.roles r,
          public.permissions p,
          public.restricted_actions ra,
          public.role_catalogue c
    WHERE rp.role_id = r.id
      AND r.organization_id = _org
      AND rp.permission_id = p.id
      AND p.module = ra.module
      AND p.action = ra.action
      AND c.role_name = r.name
      AND c.restricted_authority = false
    RETURNING 1
  )
  SELECT count(*) INTO _revoked FROM removed;

  RETURN jsonb_build_object(
    'organization_id', _org,
    'roles_created', _created,
    'permissions_granted', _granted,
    'restricted_permissions_revoked', _revoked
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.provision_catalogue_roles(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_catalogue_roles(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.provision_catalogue_roles(uuid) TO service_role;

DO $do$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.provision_catalogue_roles(o.id);
  END LOOP;
END;
$do$;

CREATE OR REPLACE FUNCTION public.can_approve_restricted()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_catalogue c ON c.role_name = r.name
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = public.current_org_id()
      AND c.restricted_authority
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_approve_restricted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_approve_restricted() FROM anon;
GRANT EXECUTE ON FUNCTION public.can_approve_restricted() TO authenticated, service_role;