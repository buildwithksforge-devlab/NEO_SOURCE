-- ============ Phase 11: Finance, Accounting & Compliance ============

CREATE OR REPLACE FUNCTION public.fin_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------- Chart of accounts ----------
CREATE TABLE public.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('asset','liability','equity','revenue','cost_of_sales','operating_expense','other_income','other_expense')),
  account_group text NOT NULL DEFAULT '',
  parent_id uuid REFERENCES public.chart_of_accounts(id),
  is_header boolean NOT NULL DEFAULT false,
  postable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  currency text NOT NULL DEFAULT 'KES',
  default_tax_code_id uuid,
  department_id uuid REFERENCES public.departments(id),
  source_modules text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.tax_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  code text NOT NULL,
  name text NOT NULL,
  rate numeric(9,4) NOT NULL DEFAULT 0,
  treatment text NOT NULL DEFAULT 'standard' CHECK (treatment IN ('standard','zero_rated','exempt','withholding','service_charge')),
  inclusive boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  tax_account_id uuid REFERENCES public.chart_of_accounts(id),
  etims_code text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, effective_from)
);

ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_tax_code_fk FOREIGN KEY (default_tax_code_id) REFERENCES public.tax_codes(id);

CREATE TABLE public.account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  source_module text NOT NULL,
  event_key text NOT NULL,
  debit_account_id uuid REFERENCES public.chart_of_accounts(id),
  credit_account_id uuid REFERENCES public.chart_of_accounts(id),
  tax_account_id uuid REFERENCES public.chart_of_accounts(id),
  payment_method text,
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_mappings_uidx ON public.account_mappings
  (organization_id, source_module, event_key, coalesce(payment_method,''), coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));

-- ---------- Periods ----------
CREATE TABLE public.financial_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('future','open','soft_closed','closed','locked')),
  closed_by uuid,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE public.accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  financial_year_id uuid NOT NULL REFERENCES public.financial_years(id) ON DELETE CASCADE,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('future','open','soft_closed','closed','locked')),
  closed_by uuid,
  closed_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, financial_year_id, name)
);

-- ---------- Journals ----------
CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  journal_number text NOT NULL,
  journal_type text NOT NULL DEFAULT 'general' CHECK (journal_type IN ('general','automatic','adjustment','reversal','opening','closing')),
  accounting_date date NOT NULL DEFAULT CURRENT_DATE,
  period_id uuid REFERENCES public.accounting_periods(id),
  source_module text NOT NULL DEFAULT 'manual',
  source_document_type text NOT NULL DEFAULT '',
  source_document_id uuid,
  document_number text NOT NULL DEFAULT '',
  idempotency_key text,
  description text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'KES',
  exchange_rate numeric(18,6) NOT NULL DEFAULT 1,
  total_debit numeric(18,2) NOT NULL DEFAULT 0,
  total_credit numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','posted','reversed','rejected')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  reverses_journal_id uuid REFERENCES public.journal_entries(id),
  reversed_by_journal_id uuid REFERENCES public.journal_entries(id),
  created_by uuid,
  posted_by uuid,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, journal_number)
);
CREATE UNIQUE INDEX journal_entries_idem_uidx ON public.journal_entries (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX journal_entries_period_idx ON public.journal_entries (organization_id, accounting_date, status);

CREATE TABLE public.journal_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  journal_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  account_id uuid NOT NULL REFERENCES public.chart_of_accounts(id),
  description text NOT NULL DEFAULT '',
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  cost_centre text,
  revenue_centre text,
  customer_id uuid REFERENCES public.customers(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  supplier_id uuid REFERENCES public.suppliers(id),
  folio_id uuid REFERENCES public.folios(id),
  event_booking_id uuid REFERENCES public.event_bookings(id),
  payment_method text,
  tax_code_id uuid REFERENCES public.tax_codes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX journal_entry_lines_journal_idx ON public.journal_entry_lines (journal_id);
CREATE INDEX journal_entry_lines_account_idx ON public.journal_entry_lines (organization_id, account_id);

-- ---------- Invoices / notes ----------
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  invoice_number text NOT NULL,
  document_type text NOT NULL DEFAULT 'tax_invoice' CHECK (document_type IN ('proforma','tax_invoice','simplified_invoice','corporate_invoice','event_invoice','folio_invoice')),
  customer_id uuid REFERENCES public.customers(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  folio_id uuid REFERENCES public.folios(id),
  event_booking_id uuid REFERENCES public.event_bookings(id),
  reservation_id uuid REFERENCES public.reservations(id),
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  currency text NOT NULL DEFAULT 'KES',
  bill_to_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  issuer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  discount_total numeric(18,2) NOT NULL DEFAULT 0,
  service_charge_total numeric(18,2) NOT NULL DEFAULT 0,
  tax_total numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  balance numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','overdue','cancelled','written_off')),
  etims_status text NOT NULL DEFAULT 'not_required',
  journal_id uuid REFERENCES public.journal_entries(id),
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number)
);
CREATE INDEX invoices_customer_idx ON public.invoices (organization_id, customer_id, status);

CREATE TABLE public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  source_module text NOT NULL DEFAULT '',
  source_record_id uuid,
  revenue_account_id uuid REFERENCES public.chart_of_accounts(id),
  department_id uuid REFERENCES public.departments(id),
  quantity numeric(18,3) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_code_id uuid REFERENCES public.tax_codes(id),
  tax_rate numeric(9,4) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_lines_invoice_idx ON public.invoice_lines (invoice_id);

CREATE TABLE public.credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  note_number text NOT NULL,
  note_kind text NOT NULL DEFAULT 'credit' CHECK (note_kind IN ('credit','debit')),
  invoice_id uuid REFERENCES public.invoices(id),
  customer_id uuid REFERENCES public.customers(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  currency text NOT NULL DEFAULT 'KES',
  reason text NOT NULL DEFAULT '',
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  tax_total numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','issued','rejected','cancelled')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  journal_id uuid REFERENCES public.journal_entries(id),
  etims_status text NOT NULL DEFAULT 'not_required',
  evidence_url text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, note_number)
);

-- ---------- Receivables ----------
CREATE TABLE public.corporate_credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  customer_id uuid REFERENCES public.customers(id),
  applicant_name text NOT NULL DEFAULT '',
  registration_number text NOT NULL DEFAULT '',
  tax_pin text NOT NULL DEFAULT '',
  contact_person text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  billing_address text NOT NULL DEFAULT '',
  requested_limit numeric(18,2) NOT NULL DEFAULT 0,
  requested_terms_days integer NOT NULL DEFAULT 30,
  expected_monthly_business numeric(18,2) NOT NULL DEFAULT 0,
  risk_notes text NOT NULL DEFAULT '',
  trade_references text NOT NULL DEFAULT '',
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','approved','rejected','suspended','expired')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  approved_limit numeric(18,2),
  approved_terms_days integer,
  expires_on date,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  statement_number text NOT NULL,
  customer_id uuid REFERENCES public.customers(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  charges numeric(18,2) NOT NULL DEFAULT 0,
  payments numeric(18,2) NOT NULL DEFAULT 0,
  closing_balance numeric(18,2) NOT NULL DEFAULT 0,
  bucket_current numeric(18,2) NOT NULL DEFAULT 0,
  bucket_30 numeric(18,2) NOT NULL DEFAULT 0,
  bucket_60 numeric(18,2) NOT NULL DEFAULT 0,
  bucket_90 numeric(18,2) NOT NULL DEFAULT 0,
  bucket_over_90 numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','sent')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, statement_number)
);

CREATE TABLE public.collection_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid REFERENCES public.customers(id),
  corporate_account_id uuid REFERENCES public.corporate_accounts(id),
  invoice_id uuid REFERENCES public.invoices(id),
  note_type text NOT NULL DEFAULT 'call' CHECK (note_type IN ('call','email','visit','promise','dispute','reminder','escalation')),
  note text NOT NULL DEFAULT '',
  promised_amount numeric(18,2),
  promised_date date,
  outcome text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Payables ----------
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS match_status text NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES public.approval_requests(id),
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS journal_id uuid REFERENCES public.journal_entries(id),
  ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_unique_number
  ON public.supplier_invoices (organization_id, supplier_id, lower(invoice_number));

CREATE TABLE public.supplier_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  line_number integer NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  stock_item_id uuid REFERENCES public.stock_items(id),
  expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  department_id uuid REFERENCES public.departments(id),
  quantity numeric(18,3) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  tax_code_id uuid REFERENCES public.tax_codes(id),
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  supplier_id uuid REFERENCES public.suppliers(id),
  supplier_invoice_id uuid REFERENCES public.supplier_invoices(id),
  scheduled_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  method text NOT NULL DEFAULT 'bank_transfer',
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','pending_approval','approved','paid','cancelled')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  payment_number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  supplier_invoice_id uuid REFERENCES public.supplier_invoices(id),
  schedule_id uuid REFERENCES public.payment_schedules(id),
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  method text NOT NULL DEFAULT 'bank_transfer',
  bank_account_id uuid,
  external_reference text NOT NULL DEFAULT '',
  paid_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','failed','cancelled','reversed')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  reconciliation_status text NOT NULL DEFAULT 'unreconciled',
  journal_id uuid REFERENCES public.journal_entries(id),
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, payment_number)
);

-- ---------- Cash / bank ----------
CREATE TABLE public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  name text NOT NULL,
  account_kind text NOT NULL DEFAULT 'bank' CHECK (account_kind IN ('bank','mpesa','card_clearing','cash','ota_clearing')),
  bank_name text NOT NULL DEFAULT '',
  account_number_masked text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'KES',
  gl_account_id uuid REFERENCES public.chart_of_accounts(id),
  provider_status text NOT NULL DEFAULT 'not_configured' CHECK (provider_status IN ('not_configured','manual','configured')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_payments
  ADD CONSTRAINT supplier_payments_bank_fk FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

CREATE TABLE public.cash_drawers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  name text NOT NULL,
  location text NOT NULL DEFAULT '',
  gl_account_id uuid REFERENCES public.chart_of_accounts(id),
  assigned_user_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cash_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  shift_id uuid REFERENCES public.pos_shifts(id),
  drawer_id uuid REFERENCES public.cash_drawers(id),
  counted_by uuid,
  denominations jsonb NOT NULL DEFAULT '[]'::jsonb,
  counted_total numeric(18,2) NOT NULL DEFAULT 0,
  expected_total numeric(18,2) NOT NULL DEFAULT 0,
  variance numeric(18,2) NOT NULL DEFAULT 0,
  variance_reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','pending_approval','approved','investigating','rejected')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cash_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  transfer_number text NOT NULL,
  from_drawer_id uuid REFERENCES public.cash_drawers(id),
  to_destination text NOT NULL DEFAULT 'safe' CHECK (to_destination IN ('safe','bank','drawer')),
  to_drawer_id uuid REFERENCES public.cash_drawers(id),
  bank_account_id uuid REFERENCES public.bank_accounts(id),
  amount numeric(18,2) NOT NULL DEFAULT 0,
  sent_by uuid,
  sent_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid,
  received_at timestamptz,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','received','disputed','cancelled')),
  notes text NOT NULL DEFAULT '',
  journal_id uuid REFERENCES public.journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, transfer_number)
);

CREATE TABLE public.bank_statement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  value_date date NOT NULL DEFAULT CURRENT_DATE,
  description text NOT NULL DEFAULT '',
  external_reference text NOT NULL DEFAULT '',
  amount numeric(18,2) NOT NULL DEFAULT 0,
  direction text NOT NULL DEFAULT 'credit' CHECK (direction IN ('debit','credit')),
  fees numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unreconciled' CHECK (status IN ('unreconciled','partially_reconciled','reconciled','exception','disputed')),
  imported_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_statement_entries_acct_idx ON public.bank_statement_entries (organization_id, bank_account_id, value_date);

CREATE TABLE public.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  reconciliation_number text NOT NULL,
  workspace text NOT NULL CHECK (workspace IN ('cash','bank','mpesa','card','ota','corporate_receipts','supplier_payments')),
  bank_account_id uuid REFERENCES public.bank_accounts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  statement_balance numeric(18,2) NOT NULL DEFAULT 0,
  ledger_balance numeric(18,2) NOT NULL DEFAULT 0,
  difference numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','reconciled','exception','reopened')),
  notes text NOT NULL DEFAULT '',
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  reopened_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, reconciliation_number)
);

CREATE TABLE public.reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  reconciliation_id uuid NOT NULL REFERENCES public.reconciliations(id) ON DELETE CASCADE,
  statement_entry_id uuid REFERENCES public.bank_statement_entries(id),
  payment_id uuid REFERENCES public.payments(id),
  supplier_payment_id uuid REFERENCES public.supplier_payments(id),
  match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact','partial','one_to_many','many_to_one','manual','fee')),
  amount numeric(18,2) NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '',
  matched_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- OTA ----------
CREATE TABLE public.ota_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  connection_id uuid REFERENCES public.ota_connections(id),
  provider text NOT NULL DEFAULT '',
  reservation_id uuid REFERENCES public.reservations(id),
  reservation_reference text NOT NULL DEFAULT '',
  guest_name text NOT NULL DEFAULT '',
  gross_amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  commission_rate numeric(9,4) NOT NULL DEFAULT 0,
  commission_amount numeric(18,2) NOT NULL DEFAULT 0,
  net_expected numeric(18,2) NOT NULL DEFAULT 0,
  payment_model text NOT NULL DEFAULT 'hotel_collect' CHECK (payment_model IN ('hotel_collect','agency_collect','virtual_card')),
  settlement_date date,
  collected_amount numeric(18,2) NOT NULL DEFAULT 0,
  collection_status text NOT NULL DEFAULT 'pending',
  reconciliation_status text NOT NULL DEFAULT 'unreconciled',
  provider_reference text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ota_vcc_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ota_receivable_id uuid NOT NULL REFERENCES public.ota_receivables(id) ON DELETE CASCADE,
  card_last_four text NOT NULL DEFAULT '',
  activation_date date,
  expiry_date date,
  chargeable_amount numeric(18,2) NOT NULL DEFAULT 0,
  charged_amount numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not_available' CHECK (status IN ('not_available','not_active','ready_to_charge','collected','partially_collected','failed','expired','disputed')),
  last_attempt_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Tax / eTIMS ----------
CREATE TABLE public.tax_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  tax_code_id uuid REFERENCES public.tax_codes(id),
  source_module text NOT NULL DEFAULT '',
  source_document_type text NOT NULL DEFAULT '',
  source_document_id uuid,
  document_number text NOT NULL DEFAULT '',
  transaction_date date NOT NULL DEFAULT CURRENT_DATE,
  taxable_amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_rate numeric(9,4) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  direction text NOT NULL DEFAULT 'output' CHECK (direction IN ('output','input','withholding')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.etims_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  document_kind text NOT NULL DEFAULT 'invoice' CHECK (document_kind IN ('invoice','credit_note','debit_note')),
  invoice_id uuid REFERENCES public.invoices(id),
  credit_note_id uuid REFERENCES public.credit_notes(id),
  document_number text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('not_required','pending','queued','submitted','accepted','rejected','failed','retry_required','cancelled_by_credit_note')),
  kra_reference text,
  control_unit_reference text,
  qr_payload text,
  error_details text,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.etims_submission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES public.etims_submissions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL DEFAULT 1,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL DEFAULT 'failed',
  error_details text,
  attempted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Expenses / budgets / alerts ----------
CREATE TABLE public.expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  expense_number text NOT NULL,
  category text NOT NULL DEFAULT '',
  expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  supplier_id uuid REFERENCES public.suppliers(id),
  payee text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  amount numeric(18,2) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'KES',
  method text NOT NULL DEFAULT 'cash',
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  attachment_url text,
  cost_centre text,
  event_booking_id uuid REFERENCES public.event_bookings(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','pending_approval','approved','rejected','scheduled','paid')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  journal_id uuid REFERENCES public.journal_entries(id),
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, expense_number)
);

CREATE TABLE public.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  department_id uuid REFERENCES public.departments(id),
  financial_year_id uuid REFERENCES public.financial_years(id),
  name text NOT NULL,
  scope text NOT NULL DEFAULT 'organization' CHECK (scope IN ('organization','branch','department','account')),
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','archived')),
  approval_request_id uuid REFERENCES public.approval_requests(id),
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  budget_id uuid NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.chart_of_accounts(id),
  period_id uuid REFERENCES public.accounting_periods(id),
  month_index integer,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid REFERENCES public.branches(id),
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  source_module text NOT NULL DEFAULT 'finance',
  source_record_id uuid,
  amount numeric(18,2),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Grants + RLS ----------
DO $$
DECLARE t text;
DECLARE tables text[] := ARRAY[
  'chart_of_accounts','tax_codes','account_mappings','financial_years','accounting_periods',
  'journal_entries','journal_entry_lines','invoices','invoice_lines','credit_notes',
  'corporate_credit_applications','customer_statements','collection_notes',
  'supplier_invoice_lines','payment_schedules','supplier_payments',
  'bank_accounts','cash_drawers','cash_counts','cash_transfers','bank_statement_entries',
  'reconciliations','reconciliation_matches','ota_receivables','ota_vcc_records',
  'tax_transactions','etims_submissions','etims_submission_attempts',
  'expense_claims','budgets','budget_lines','financial_alerts'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY finance_read_%1$s ON public.%1$I FOR SELECT TO authenticated USING (organization_id = current_org_id() AND (has_permission('finance','view') OR is_org_admin()))$p$, t);
    EXECUTE format($p$CREATE POLICY finance_insert_%1$s ON public.%1$I FOR INSERT TO authenticated WITH CHECK (organization_id = current_org_id() AND (has_permission('finance','create') OR is_org_admin()))$p$, t);
    EXECUTE format($p$CREATE POLICY finance_update_%1$s ON public.%1$I FOR UPDATE TO authenticated USING (organization_id = current_org_id() AND (has_permission('finance','edit') OR is_org_admin())) WITH CHECK (organization_id = current_org_id())$p$, t);
    EXECUTE format($p$CREATE POLICY finance_delete_%1$s ON public.%1$I FOR DELETE TO authenticated USING (organization_id = current_org_id() AND is_org_admin())$p$, t);
    IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=t AND c.column_name='updated_at') THEN
      EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- Customers read their own financial documents
CREATE POLICY customer_read_invoices ON public.invoices FOR SELECT TO authenticated
  USING (customer_id = my_customer_id());
CREATE POLICY customer_read_invoice_lines ON public.invoice_lines FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM public.invoices WHERE customer_id = my_customer_id()));
CREATE POLICY customer_read_credit_notes ON public.credit_notes FOR SELECT TO authenticated
  USING (customer_id = my_customer_id());
CREATE POLICY customer_read_statements ON public.customer_statements FOR SELECT TO authenticated
  USING (customer_id = my_customer_id());

-- ---------- Immutability of posted journals ----------
CREATE OR REPLACE FUNCTION public.fin_protect_posted_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted','reversed') THEN RAISE EXCEPTION 'Posted journals cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' AND NEW.status NOT IN ('posted','reversed') THEN
    RAISE EXCEPTION 'Posted journals are immutable';
  END IF;
  IF OLD.status IN ('posted','reversed') AND (
      NEW.total_debit <> OLD.total_debit OR NEW.total_credit <> OLD.total_credit
      OR NEW.accounting_date <> OLD.accounting_date OR NEW.journal_number <> OLD.journal_number) THEN
    RAISE EXCEPTION 'Posted journals are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin_protect_posted_journal();

CREATE OR REPLACE FUNCTION public.fin_protect_posted_journal_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM public.journal_entries WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF s IN ('posted','reversed') THEN RAISE EXCEPTION 'Lines of a posted journal cannot change'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER journal_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.fin_protect_posted_journal_lines();

-- Accounts with activity cannot be deleted
CREATE OR REPLACE FUNCTION public.fin_protect_used_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'Account has financial activity and cannot be deleted; deactivate it instead';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER chart_of_accounts_protect BEFORE DELETE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.fin_protect_used_account();

-- ---------- Posting engine ----------
CREATE OR REPLACE FUNCTION public.fin_period_for(_org uuid, _date date)
RETURNS public.accounting_periods LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.accounting_periods
  WHERE organization_id = _org AND _date BETWEEN starts_on AND ends_on
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fin_post_journal(_journal uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.journal_entries; p public.accounting_periods; d numeric; c numeric; bad int;
BEGIN
  SELECT * INTO j FROM public.journal_entries WHERE id = _journal;
  IF j.id IS NULL THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF j.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF j.status = 'posted' THEN RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', j.id); END IF;
  IF j.status NOT IN ('draft','approved') THEN RAISE EXCEPTION 'Journal cannot be posted from status %', j.status; END IF;

  SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0) INTO d, c
    FROM public.journal_entry_lines WHERE journal_id = j.id;
  IF d = 0 AND c = 0 THEN RAISE EXCEPTION 'Journal has no lines'; END IF;
  IF d <> c THEN RAISE EXCEPTION 'Journal is not balanced (debit % vs credit %)', d, c; END IF;

  SELECT count(*) INTO bad FROM public.journal_entry_lines l
    JOIN public.chart_of_accounts a ON a.id = l.account_id
    WHERE l.journal_id = j.id AND (a.active = false OR a.postable = false OR a.is_header = true);
  IF bad > 0 THEN RAISE EXCEPTION 'Journal references inactive or non-postable accounts'; END IF;

  SELECT * INTO p FROM public.fin_period_for(j.organization_id, j.accounting_date);
  IF p.id IS NULL THEN RAISE EXCEPTION 'No accounting period covers %', j.accounting_date; END IF;
  IF p.status NOT IN ('open') AND NOT (p.status = 'soft_closed' AND j.journal_type = 'adjustment') THEN
    RAISE EXCEPTION 'Accounting period % is %', p.name, p.status;
  END IF;

  IF j.source_document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.journal_entries x
      WHERE x.organization_id = j.organization_id AND x.id <> j.id
        AND x.source_document_type = j.source_document_type
        AND x.source_document_id = j.source_document_id
        AND x.status = 'posted' AND x.journal_type <> 'reversal') THEN
    RAISE EXCEPTION 'This source document has already been posted';
  END IF;

  UPDATE public.journal_entries
    SET status='posted', total_debit=d, total_credit=c, period_id=p.id,
        posted_by=auth.uid(), posted_at=now()
    WHERE id = j.id;

  RETURN jsonb_build_object('ok', true, 'journal_id', j.id, 'total', d, 'period', p.name);
END $$;

CREATE OR REPLACE FUNCTION public.fin_reverse_journal(_journal uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.journal_entries; nid uuid; num text;
BEGIN
  SELECT * INTO j FROM public.journal_entries WHERE id = _journal;
  IF j.id IS NULL OR j.organization_id <> current_org_id() THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF j.status <> 'posted' THEN RAISE EXCEPTION 'Only posted journals can be reversed'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;

  num := public.next_document_number('journal');
  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type, accounting_date,
    source_module, source_document_type, source_document_id, document_number, description, currency,
    reverses_journal_id, created_by, status)
  VALUES (j.organization_id, j.branch_id, num, 'reversal', CURRENT_DATE,
    j.source_module, j.source_document_type, j.source_document_id, j.document_number,
    'Reversal of ' || j.journal_number || ' — ' || _reason, j.currency, j.id, auth.uid(), 'draft')
  RETURNING id INTO nid;

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id, description,
    debit, credit, branch_id, department_id, cost_centre, revenue_centre, customer_id, corporate_account_id,
    supplier_id, folio_id, event_booking_id, payment_method, tax_code_id)
  SELECT organization_id, nid, line_number, account_id, 'Reversal: ' || description,
    credit, debit, branch_id, department_id, cost_centre, revenue_centre, customer_id, corporate_account_id,
    supplier_id, folio_id, event_booking_id, payment_method, tax_code_id
  FROM public.journal_entry_lines WHERE journal_id = j.id;

  PERFORM public.fin_post_journal(nid);
  UPDATE public.journal_entries SET status='reversed', reversed_by_journal_id=nid WHERE id=j.id;
  RETURN jsonb_build_object('ok', true, 'reversal_journal_id', nid, 'journal_number', num);
END $$;

CREATE OR REPLACE FUNCTION public.fin_trial_balance(_from date, _to date, _branch uuid DEFAULT NULL)
RETURNS TABLE(account_id uuid, code text, name text, category text, debit numeric, credit numeric, balance numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.code, a.name, a.category,
         COALESCE(sum(l.debit),0), COALESCE(sum(l.credit),0),
         COALESCE(sum(l.debit),0) - COALESCE(sum(l.credit),0)
  FROM public.chart_of_accounts a
  LEFT JOIN public.journal_entry_lines l ON l.account_id = a.id
  LEFT JOIN public.journal_entries j ON j.id = l.journal_id AND j.status = 'posted'
       AND j.accounting_date BETWEEN _from AND _to
       AND (_branch IS NULL OR j.branch_id = _branch)
  WHERE a.organization_id = current_org_id()
    AND (has_permission('finance','view') OR is_org_admin())
    AND j.id IS NOT NULL
  GROUP BY a.id, a.code, a.name, a.category
  ORDER BY a.code;
$$;

CREATE OR REPLACE FUNCTION public.fin_metrics(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := current_org_id(); f date := COALESCE(_from, date_trunc('month', CURRENT_DATE)::date); t date := COALESCE(_to, CURRENT_DATE);
DECLARE res jsonb;
BEGIN
  IF org IS NULL OR NOT (has_permission('finance','view') OR is_org_admin()) THEN RETURN '{}'::jsonb; END IF;
  SELECT jsonb_build_object(
    'revenue_today', (SELECT COALESCE(sum(l.credit - l.debit),0) FROM public.journal_entry_lines l
        JOIN public.journal_entries j ON j.id=l.journal_id AND j.status='posted' AND j.accounting_date=CURRENT_DATE
        JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.category='revenue'
        WHERE l.organization_id=org AND (_branch IS NULL OR j.branch_id=_branch)),
    'revenue_period', (SELECT COALESCE(sum(l.credit - l.debit),0) FROM public.journal_entry_lines l
        JOIN public.journal_entries j ON j.id=l.journal_id AND j.status='posted' AND j.accounting_date BETWEEN f AND t
        JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.category='revenue'
        WHERE l.organization_id=org AND (_branch IS NULL OR j.branch_id=_branch)),
    'revenue_ytd', (SELECT COALESCE(sum(l.credit - l.debit),0) FROM public.journal_entry_lines l
        JOIN public.journal_entries j ON j.id=l.journal_id AND j.status='posted'
          AND j.accounting_date >= date_trunc('year', CURRENT_DATE)::date
        JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.category='revenue'
        WHERE l.organization_id=org),
    'expenses_period', (SELECT COALESCE(sum(l.debit - l.credit),0) FROM public.journal_entry_lines l
        JOIN public.journal_entries j ON j.id=l.journal_id AND j.status='posted' AND j.accounting_date BETWEEN f AND t
        JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.category IN ('cost_of_sales','operating_expense','other_expense')
        WHERE l.organization_id=org),
    'ar_outstanding', (SELECT COALESCE(sum(balance),0) FROM public.invoices WHERE organization_id=org AND status IN ('issued','partially_paid','overdue')),
    'ar_overdue', (SELECT COALESCE(sum(balance),0) FROM public.invoices WHERE organization_id=org AND status IN ('issued','partially_paid','overdue') AND due_date < CURRENT_DATE),
    'ap_outstanding', (SELECT COALESCE(sum(amount - paid_amount),0) FROM public.supplier_invoices WHERE organization_id=org AND status <> 'paid'),
    'folio_balances', (SELECT COALESCE(sum(balance),0) FROM public.folios WHERE organization_id=org AND status='open'),
    'payments_period', (SELECT COALESCE(sum(amount),0) FROM public.payments WHERE organization_id=org AND paid_at::date BETWEEN f AND t AND status IN ('confirmed','successful')),
    'unreconciled', (SELECT count(*) FROM public.bank_statement_entries WHERE organization_id=org AND status='unreconciled'),
    'ota_uncollected', (SELECT COALESCE(sum(net_expected - collected_amount),0) FROM public.ota_receivables WHERE organization_id=org AND collection_status <> 'collected'),
    'etims_failed', (SELECT count(*) FROM public.etims_submissions WHERE organization_id=org AND status IN ('failed','rejected','retry_required')),
    'open_alerts', (SELECT count(*) FROM public.financial_alerts WHERE organization_id=org AND status='open'),
    'pending_approvals', (SELECT count(*) FROM public.approval_requests WHERE organization_id=org AND status='pending'),
    'draft_journals', (SELECT count(*) FROM public.journal_entries WHERE organization_id=org AND status IN ('draft','pending_approval')),
    'revenue_by_method', (SELECT COALESCE(jsonb_object_agg(method, total),'{}'::jsonb) FROM (
        SELECT method, sum(amount) total FROM public.payments
        WHERE organization_id=org AND paid_at::date BETWEEN f AND t AND status IN ('confirmed','successful')
        GROUP BY method) m),
    'period_status', (SELECT status FROM public.accounting_periods WHERE organization_id=org AND CURRENT_DATE BETWEEN starts_on AND ends_on LIMIT 1)
  ) INTO res;
  RETURN res;
END $$;

-- Seed a default chart of accounts + periods for an organization (idempotent)
CREATE OR REPLACE FUNCTION public.fin_seed_finance_defaults()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org uuid := current_org_id(); created int := 0; fy uuid; m int; y int := extract(year from CURRENT_DATE)::int;
BEGIN
  IF org IS NULL THEN RAISE EXCEPTION 'No organization'; END IF;
  IF NOT (has_permission('finance','create') OR is_org_admin()) THEN RAISE EXCEPTION 'Not permitted'; END IF;

  INSERT INTO public.chart_of_accounts (organization_id, code, name, category, account_group, is_header, postable, created_by)
  SELECT org, v.code, v.name, v.category, v.grp, v.header, NOT v.header, auth.uid()
  FROM (VALUES
    ('1000','Assets','asset','Assets',true),
    ('1010','Cash on Hand','asset','Cash & Bank',false),
    ('1020','Bank Accounts','asset','Cash & Bank',false),
    ('1030','M-Pesa Clearing','asset','Cash & Bank',false),
    ('1040','Card Clearing','asset','Cash & Bank',false),
    ('1050','OTA Receivables','asset','Receivables',false),
    ('1060','Accounts Receivable','asset','Receivables',false),
    ('1070','Inventory','asset','Inventory',false),
    ('1080','Prepayments','asset','Other Assets',false),
    ('1090','Fixed Assets','asset','Fixed Assets',false),
    ('1095','Accumulated Depreciation','asset','Fixed Assets',false),
    ('2000','Liabilities','liability','Liabilities',true),
    ('2010','Accounts Payable','liability','Payables',false),
    ('2015','Goods Received Not Invoiced','liability','Payables',false),
    ('2020','Guest Deposits','liability','Deposits',false),
    ('2030','Event Deposits','liability','Deposits',false),
    ('2040','VAT Payable','liability','Tax',false),
    ('2050','Service Charge Payable','liability','Tax',false),
    ('2060','Customer Credit Balances','liability','Payables',false),
    ('2070','Accrued Expenses','liability','Payables',false),
    ('3000','Equity','equity','Equity',true),
    ('3010','Retained Earnings','equity','Equity',false),
    ('4000','Revenue','revenue','Revenue',true),
    ('4010','Room Revenue','revenue','Revenue',false),
    ('4020','Restaurant Revenue','revenue','Revenue',false),
    ('4030','Bar Revenue','revenue','Revenue',false),
    ('4040','Room Service Revenue','revenue','Revenue',false),
    ('4050','Laundry Revenue','revenue','Revenue',false),
    ('4060','Event Revenue','revenue','Revenue',false),
    ('4070','Delivery Revenue','revenue','Revenue',false),
    ('4080','Transport Revenue','revenue','Revenue',false),
    ('4090','Other Revenue','other_income','Revenue',false),
    ('4095','Refunds & Revenue Reversals','revenue','Revenue',false),
    ('5000','Cost of Sales','cost_of_sales','Cost of Sales',true),
    ('5010','Food Cost','cost_of_sales','Cost of Sales',false),
    ('5020','Beverage Cost','cost_of_sales','Cost of Sales',false),
    ('6000','Operating Expenses','operating_expense','Operating Expenses',true),
    ('6010','Guest Amenities','operating_expense','Operating Expenses',false),
    ('6020','Cleaning Supplies','operating_expense','Operating Expenses',false),
    ('6030','Utilities','operating_expense','Operating Expenses',false),
    ('6040','Maintenance','operating_expense','Operating Expenses',false),
    ('6050','Marketing','operating_expense','Operating Expenses',false),
    ('6060','Transport','operating_expense','Operating Expenses',false),
    ('6070','Staff Expense','operating_expense','Operating Expenses',false),
    ('6080','OTA Commission','operating_expense','Operating Expenses',false),
    ('6090','Bank Charges','operating_expense','Operating Expenses',false),
    ('6095','M-Pesa Charges','operating_expense','Operating Expenses',false),
    ('6099','Other Operating Expenses','operating_expense','Operating Expenses',false)
  ) AS v(code,name,category,grp,header)
  WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts a WHERE a.organization_id=org AND a.code=v.code);
  GET DIAGNOSTICS created = ROW_COUNT;

  INSERT INTO public.tax_codes (organization_id, code, name, rate, treatment, created_by)
  SELECT org, v.code, v.name, v.rate, v.treatment, auth.uid()
  FROM (VALUES ('VAT16','VAT Standard 16%',0.16,'standard'),('VAT0','Zero Rated',0,'zero_rated'),('EXEMPT','Exempt',0,'exempt'),('SC','Service Charge',0.10,'service_charge')) AS v(code,name,rate,treatment)
  WHERE NOT EXISTS (SELECT 1 FROM public.tax_codes tc WHERE tc.organization_id=org AND tc.code=v.code);

  SELECT id INTO fy FROM public.financial_years WHERE organization_id=org AND name=y::text;
  IF fy IS NULL THEN
    INSERT INTO public.financial_years (organization_id, name, starts_on, ends_on, status, created_by)
    VALUES (org, y::text, make_date(y,1,1), make_date(y,12,31), 'open', auth.uid()) RETURNING id INTO fy;
    FOR m IN 1..12 LOOP
      INSERT INTO public.accounting_periods (organization_id, financial_year_id, name, starts_on, ends_on, status)
      VALUES (org, fy, to_char(make_date(y,m,1),'Mon YYYY'), make_date(y,m,1), (make_date(y,m,1) + interval '1 month - 1 day')::date,
        CASE WHEN make_date(y,m,1) > CURRENT_DATE THEN 'future' ELSE 'open' END);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'accounts_created', created, 'financial_year_id', fy);
END $$;

REVOKE ALL ON FUNCTION public.fin_post_journal(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_reverse_journal(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_metrics(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_trial_balance(date, date, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_seed_finance_defaults() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_period_for(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_post_journal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_reverse_journal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_metrics(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_trial_balance(date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_seed_finance_defaults() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_period_for(uuid, date) TO authenticated;

-- ---------- Permissions ----------
INSERT INTO public.permissions (module, action, label)
SELECT v.m, v.a, v.l FROM (VALUES
  ('finance-gl','view','View Accounts & Journals'),
  ('finance-gl','manage_accounts','Manage Chart of Accounts'),
  ('finance-gl','create_journal','Create Journal'),
  ('finance-gl','approve_journal','Approve Journal'),
  ('finance-gl','post_journal','Post Journal'),
  ('finance-gl','reverse_journal','Reverse Journal'),
  ('finance-gl','close_period','Close Period'),
  ('finance-gl','reopen_period','Reopen Period'),
  ('finance-ar','view','View Receivables'),
  ('finance-ar','create_credit_application','Create Credit Application'),
  ('finance-ar','approve_credit','Approve Credit'),
  ('finance-ar','change_credit_limit','Change Credit Limit'),
  ('finance-ar','allocate_receipt','Allocate Receipt'),
  ('finance-ar','create_statement','Create Statement'),
  ('finance-ar','record_collection_note','Record Collection Note'),
  ('finance-ar','request_write_off','Request Write-Off'),
  ('finance-ar','approve_write_off','Approve Write-Off'),
  ('finance-ap','view','View Payables'),
  ('finance-ap','record_supplier_invoice','Record Supplier Invoice'),
  ('finance-ap','approve_supplier_invoice','Approve Supplier Invoice'),
  ('finance-ap','approve_match_variance','Approve Match Variance'),
  ('finance-ap','schedule_payment','Schedule Supplier Payment'),
  ('finance-ap','approve_payment','Approve Supplier Payment'),
  ('finance-ap','record_payment','Record Supplier Payment'),
  ('finance-payments','receive_payment','Receive Payment'),
  ('finance-payments','open_shift','Open Shift'),
  ('finance-payments','close_shift','Close Shift'),
  ('finance-payments','count_cash','Count Cash'),
  ('finance-payments','approve_cash_variance','Approve Cash Variance'),
  ('finance-payments','reconcile','Reconcile Payments'),
  ('finance-payments','reverse_payment','Reverse Payment'),
  ('finance-payments','refund_payment','Refund Payment'),
  ('finance-tax','view','View Tax'),
  ('finance-tax','configure','Configure Tax'),
  ('finance-tax','submit_etims','Submit eTIMS'),
  ('finance-tax','retry_etims','Retry eTIMS'),
  ('finance-tax','issue_credit_note','Issue Credit Note'),
  ('finance-tax','view_compliance','View Compliance Reports'),
  ('finance-reports','view','View Financial Reports'),
  ('finance-reports','view_costs','View Costs'),
  ('finance-reports','view_profit','View Profit'),
  ('finance-reports','export','Export Financial Reports'),
  ('finance-reports','print','Print Financial Reports'),
  ('finance','view','View Finance'),
  ('finance','create','Create Finance Records'),
  ('finance','edit','Edit Finance Records'),
  ('finance','approve','Approve Finance Records')
) AS v(m,a,l)
WHERE NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.module=v.m AND p.action=v.a);

-- Financial approval types for every organization
INSERT INTO public.approval_types (organization_id, key, name, levels)
SELECT o.id, v.k, v.n, 1 FROM public.organizations o
CROSS JOIN (VALUES
  ('finance_bill_void','Bill Void'),
  ('finance_refund','Refund'),
  ('finance_discount','Discount Override'),
  ('finance_complimentary','Complimentary Transaction'),
  ('finance_rate_override','Rate Override'),
  ('finance_credit_application','Credit Application'),
  ('finance_credit_limit','Credit Limit Override'),
  ('finance_write_off','Bad Debt Write-Off'),
  ('finance_expense','Expense Approval'),
  ('finance_supplier_variance','Supplier Invoice Variance'),
  ('finance_supplier_payment','Supplier Payment'),
  ('finance_cash_variance','Cash Variance'),
  ('finance_journal','Journal Entry'),
  ('finance_period_reopen','Period Reopening')
) AS v(k,n)
WHERE NOT EXISTS (SELECT 1 FROM public.approval_types t WHERE t.organization_id=o.id AND t.key=v.k);

-- Grant all new finance permissions to administrator-style roles
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT r.organization_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.module LIKE 'finance%'
WHERE r.name ILIKE ANY (ARRAY['%administrator%','%owner%','%director%','%finance%'])
  AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp WHERE rp.role_id=r.id AND rp.permission_id=p.id);