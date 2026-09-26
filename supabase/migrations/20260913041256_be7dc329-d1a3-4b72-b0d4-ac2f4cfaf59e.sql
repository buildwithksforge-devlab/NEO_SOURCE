ALTER TABLE public.department_stock_needs
  ADD CONSTRAINT department_stock_needs_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;

ALTER TABLE public.department_stock_needs
  ADD CONSTRAINT department_stock_needs_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

ALTER TABLE public.department_stock_needs
  ADD CONSTRAINT department_stock_needs_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;