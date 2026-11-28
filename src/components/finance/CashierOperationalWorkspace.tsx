import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";

export function CashierOperationalWorkspace() {
  const { can } = useAuth();

  const sections = [
    {
      title: "Till and collections",
      items: [
        {
          title: "My till",
          description: "Current collection point and payment requests.",
          to: "/finance/till",
          visible: true,
        },
        {
          title: "Collection history",
          description: "Review recorded payments and collection evidence.",
          to: "/finance/collections",
          visible: true,
        },
        {
          title: "Cashier shifts",
          description: "Opening cash, shift activity and closing records.",
          to: "/pos/shifts",
          visible: true,
        },
        {
          title: "Till reconciliation",
          description: "Review expected collections and discrepancies.",
          to: "/finance/till-reconciliation",
          visible: can?.("finance", "view") === true,
        },
      ],
    },
    {
      title: "Customer accounts",
      items: [
        {
          title: "Customer directory",
          description: "Register or find a customer before recording an authorised payment or account transaction.",
          to: "/crm/customers",
          visible: can?.("crm", "view") === true || can?.("crm", "customers.create") === true,
        },
        {
          title: "Deposits",
          description: "Review customer advance payments and deposit records.",
          to: "/finance/deposits",
          visible: can?.("finance", "view") === true,
        },
        {
          title: "Outstanding receivables",
          description: "Review debts and authorised payment allocations.",
          to: "/finance/receivables",
          visible: can?.("finance", "view") === true,
        },
        {
          title: "Credit accounts",
          description: "Review approved credit accounts, outstanding obligations and payment history.",
          to: "/credit-accounts",
          visible: can?.("finance", "view") === true,
        },
      ],
    },
  ];

  return (
    <section
      aria-label="Cashier operational workspace"
      className="space-y-4 rounded-xl border bg-card p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">
          Cashier operational workspace
        </h2>
        <p className="text-sm text-muted-foreground">
          Access collection history, reconciliation and authorised
          customer financial operations.
        </p>
      </div>

      {sections.map((section) => {
        const items = section.items.filter((item) => item.visible);

        if (items.length === 0) return null;

        return (
          <div key={section.title} className="space-y-2">
            <h3 className="text-sm font-medium">
              {section.title}
            </h3>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
                >
                  <span className="block text-sm font-medium">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {item.description}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}