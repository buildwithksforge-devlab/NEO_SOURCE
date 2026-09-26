-- Replace bare is_staff() write gates on credit, loyalty and CRM tables with
-- module.feature.action permission checks. Reads stay as they are, because
-- front office, finance, events and PMS legitimately read these records.
-- has_permission() already requires active staff and honours the two superusers.

-- 1. Corporate credit settings ------------------------------------------------
DROP POLICY IF EXISTS "staff manage credit settings" ON public.corporate_credit_settings;

CREATE POLICY "credit settings read" ON public.corporate_credit_settings
  FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());

CREATE POLICY "credit settings insert" ON public.corporate_credit_settings
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('finance','ar','change_credit_limit'));

CREATE POLICY "credit settings update" ON public.corporate_credit_settings
  FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('finance','ar','change_credit_limit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('finance','ar','change_credit_limit'));

CREATE POLICY "credit settings delete" ON public.corporate_credit_settings
  FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('finance','ar','change_credit_limit'));

-- 2. Loyalty ledger -----------------------------------------------------------
DROP POLICY IF EXISTS "staff insert loyalty ledger" ON public.loyalty_transactions;

CREATE POLICY "loyalty ledger insert" ON public.loyalty_transactions
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','loyalty','edit'));

-- 3. Reward vouchers ----------------------------------------------------------
DROP POLICY IF EXISTS "staff manage vouchers" ON public.reward_vouchers;

CREATE POLICY "vouchers read" ON public.reward_vouchers
  FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());

CREATE POLICY "vouchers insert" ON public.reward_vouchers
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','promotions','create'));

CREATE POLICY "vouchers update" ON public.reward_vouchers
  FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','promotions','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','promotions','edit'));

CREATE POLICY "vouchers delete" ON public.reward_vouchers
  FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

-- 4. CRM and marketing records ------------------------------------------------
DROP POLICY IF EXISTS "staff manage notes" ON public.customer_notes;
CREATE POLICY "notes read" ON public.customer_notes FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "notes insert" ON public.customer_notes FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-customers','create'));
CREATE POLICY "notes update" ON public.customer_notes FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','crm-customers','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-customers','edit'));
CREATE POLICY "notes delete" ON public.customer_notes FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage segments" ON public.customer_segments;
CREATE POLICY "segments read" ON public.customer_segments FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "segments insert" ON public.customer_segments FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','segments','edit'));
CREATE POLICY "segments update" ON public.customer_segments FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','segments','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','segments','edit'));
CREATE POLICY "segments delete" ON public.customer_segments FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage segment members" ON public.customer_segment_memberships;
CREATE POLICY "segment members read" ON public.customer_segment_memberships FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "segment members insert" ON public.customer_segment_memberships FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','segments','edit'));
CREATE POLICY "segment members update" ON public.customer_segment_memberships FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','segments','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','segments','edit'));
CREATE POLICY "segment members delete" ON public.customer_segment_memberships FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','segments','edit'));

DROP POLICY IF EXISTS "staff manage preferences" ON public.customer_preferences;
CREATE POLICY "preferences staff read" ON public.customer_preferences FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "preferences insert" ON public.customer_preferences FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','preferences','edit'));
CREATE POLICY "preferences update" ON public.customer_preferences FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','preferences','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','preferences','edit'));
CREATE POLICY "preferences delete" ON public.customer_preferences FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage relationships" ON public.customer_relationships;
CREATE POLICY "relationships read" ON public.customer_relationships FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "relationships insert" ON public.customer_relationships FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-customers','create'));
CREATE POLICY "relationships update" ON public.customer_relationships FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','crm-customers','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-customers','edit'));
CREATE POLICY "relationships delete" ON public.customer_relationships FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage corporate accounts" ON public.corporate_accounts;
CREATE POLICY "corporate accounts read" ON public.corporate_accounts FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "corporate accounts insert" ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','create'));
CREATE POLICY "corporate accounts update" ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','edit'));
CREATE POLICY "corporate accounts delete" ON public.corporate_accounts FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage corporate contacts" ON public.corporate_contacts;
CREATE POLICY "corporate contacts read" ON public.corporate_contacts FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "corporate contacts insert" ON public.corporate_contacts FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','create'));
CREATE POLICY "corporate contacts update" ON public.corporate_contacts FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','crm-corporate','edit'));
CREATE POLICY "corporate contacts delete" ON public.corporate_contacts FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff manage communications" ON public.customer_communications;
CREATE POLICY "communications staff read" ON public.customer_communications FOR SELECT TO authenticated
  USING (is_staff() AND organization_id = current_org_id());
CREATE POLICY "communications insert" ON public.customer_communications FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','communications','create'));
CREATE POLICY "communications update" ON public.customer_communications FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','communications','create'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','communications','create'));
CREATE POLICY "communications delete" ON public.customer_communications FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('marketing','*','delete'));

DROP POLICY IF EXISTS "staff insert ai insights" ON public.customer_ai_insights;
CREATE POLICY "ai insights insert" ON public.customer_ai_insights FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('marketing','ai','create'));
