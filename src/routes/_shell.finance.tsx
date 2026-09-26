import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SectionTabs } from "@/components/common/SectionTabs";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";

export const Route = createFileRoute("/_shell/finance")({
  component: FinanceLayout,
});

const TABS = [
  { label: "Overview", to: "/finance" },
  { label: "Cashbook", to: "/finance/cashbook" },
  { label: "Invoices", to: "/finance/receivables" },
  { label: "Payments", to: "/finance/payments" },
  { label: "Profit & Loss", to: "/finance/profit-loss" },
  { label: "Revenue", to: "/finance/revenue" },
  { label: "Cashier Till", to: "/finance/till" },
  { label: "Cashier Sessions", to: "/finance/sessions" },
  { label: "End of Day", to: "/finance/eod" },
  { label: "Chart of Accounts", to: "/finance/ledger" },
  { label: "Cashier Queue", to: "/finance/queue" },
  { label: "Transaction Register", to: "/finance/register" },
  { label: "General Ledger", to: "/finance/general-ledger" },
  { label: "Journals", to: "/finance/journals" },
  { label: "Payables", to: "/finance/payables" },
  { label: "Bank Accounts", to: "/finance/bank-accounts" },
  { label: "Banking & Cash", to: "/finance/banking" },
  { label: "Reconciliation", to: "/finance/reconciliation" },
  { label: "Tax & Compliance", to: "/finance/tax" },
  { label: "Package Allocation", to: "/finance/packages" },
  { label: "OTA Settlements", to: "/finance/ota" },
  { label: "QuickBooks", to: "/finance/quickbooks" },
];

function FinanceLayout() {
  const { can, permissionsLoaded } = useAuth();
  // The tab strip applies the same capability check as the sidebar and the
  // route guard, so a tab is never offered to a user the guard would refuse.
  const tabs = permissionsLoaded ? TABS.filter((tab) => canAccessPath(can, tab.to)) : TABS;

  return (
    <div>
      <SectionTabs tabs={tabs} rootPath="/finance" />
      <Outlet />
    </div>
  );
}
