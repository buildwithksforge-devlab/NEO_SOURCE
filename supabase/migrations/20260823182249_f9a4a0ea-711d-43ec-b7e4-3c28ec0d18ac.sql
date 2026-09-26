-- ROLE ISOLATION REPAIR 3: sensitive read/write actions must be granted
-- explicitly. Folding them into the generic view/edit classes let a narrow
-- grant (e.g. delivery orders.view-own) answer a privileged question
-- (orders.financials, payments.revenue, cost visibility, manage-all).
delete from public.permission_action_classes
 where action_suffix in (
   'financials','revenue','cost','view_costs','view_profit','view_compliance',
   'view-all','view-own','performance','rider-location','manage-all');