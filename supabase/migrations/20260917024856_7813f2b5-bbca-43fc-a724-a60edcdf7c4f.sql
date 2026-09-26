UPDATE public.payroll_posting_settings s
SET salary_expense_account_id = COALESCE(s.salary_expense_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='6071')),
    allowance_expense_account_id = COALESCE(s.allowance_expense_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='6072')),
    bonus_expense_account_id = COALESCE(s.bonus_expense_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='6073')),
    reimbursement_expense_account_id = COALESCE(s.reimbursement_expense_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='6074')),
    deduction_liability_account_id = COALESCE(s.deduction_liability_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='2075')),
    net_pay_liability_account_id = COALESCE(s.net_pay_liability_account_id,
      (SELECT id FROM public.chart_of_accounts WHERE organization_id=s.organization_id AND code='2076')),
    updated_at = now()
WHERE s.organization_id = '215224ce-cbd8-47f6-91fa-43f42f23809f';