DO $$
DECLARE org uuid := '215224ce-cbd8-47f6-91fa-43f42f23809f';
        fy uuid; m int; y int := 2026;
BEGIN
  INSERT INTO public.chart_of_accounts (organization_id, code, name, category, account_group, is_header, postable)
  SELECT org, v.code, v.name, v.category, v.grp, v.header, NOT v.header
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
    ('2075','Payroll Deductions Payable','liability','Payroll',false),
    ('2076','Net Pay Payable','liability','Payroll',false),
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
    ('6071','Salaries and Wages','operating_expense','Payroll',false),
    ('6072','Staff Allowances','operating_expense','Payroll',false),
    ('6073','Bonuses and Commission','operating_expense','Payroll',false),
    ('6074','Staff Reimbursements','operating_expense','Payroll',false),
    ('6080','OTA Commission','operating_expense','Operating Expenses',false),
    ('6090','Bank Charges','operating_expense','Operating Expenses',false),
    ('6095','M-Pesa Charges','operating_expense','Operating Expenses',false),
    ('6099','Other Operating Expenses','operating_expense','Operating Expenses',false)
  ) AS v(code,name,category,grp,header)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a WHERE a.organization_id = org AND a.code = v.code
  );

  INSERT INTO public.tax_codes (organization_id, code, name, rate, treatment)
  SELECT org, v.code, v.name, v.rate, v.treatment
  FROM (VALUES
    ('VAT16','VAT Standard 16%',0.16,'standard'),
    ('VAT0','Zero Rated',0,'zero_rated'),
    ('EXEMPT','Exempt',0,'exempt'),
    ('SC','Service Charge',0.10,'service_charge')
  ) AS v(code,name,rate,treatment)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.tax_codes tc WHERE tc.organization_id = org AND tc.code = v.code
  );

  SELECT id INTO fy FROM public.financial_years WHERE organization_id = org AND name = y::text;
  IF fy IS NULL THEN
    INSERT INTO public.financial_years (organization_id, name, starts_on, ends_on, status)
    VALUES (org, y::text, make_date(y,1,1), make_date(y,12,31), 'open')
    RETURNING id INTO fy;

    FOR m IN 1..12 LOOP
      INSERT INTO public.accounting_periods (organization_id, financial_year_id, name, starts_on, ends_on, status)
      VALUES (org, fy, to_char(make_date(y,m,1),'Mon YYYY'), make_date(y,m,1),
              (make_date(y,m,1) + interval '1 month - 1 day')::date,
              CASE WHEN make_date(y,m,1) > CURRENT_DATE THEN 'future' ELSE 'open' END);
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_posting_settings s
    WHERE s.organization_id = org AND s.branch_id IS NULL
  ) THEN
    INSERT INTO public.payroll_posting_settings (
      organization_id, branch_id,
      salary_expense_account_id, allowance_expense_account_id, bonus_expense_account_id,
      reimbursement_expense_account_id, deduction_liability_account_id, net_pay_liability_account_id
    )
    SELECT org, NULL,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='6071'),
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='6072'),
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='6073'),
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='6074'),
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='2075'),
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=org AND code='2076');
  END IF;
END $$;