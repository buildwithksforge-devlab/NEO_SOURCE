import { Link } from "@tanstack/react-router";

const stages = [
  {
    title: "Purchase requests",
    description: "Review departmental requirements and shortages.",
    to: "/procurement/requests",
  },
  {
    title: "Requests for quotations",
    description: "Create RFQs, invite suppliers and compare responses.",
    to: "/procurement/quotations",
  },
  {
    title: "Purchase orders",
    description: "Track approved supplier orders and fulfilment.",
    to: "/procurement/orders",
  },
  {
    title: "Supplier activity",
    description: "Review supplier deliveries and outstanding orders.",
    to: "/procurement/supplier-portal",
  },
  {
    title: "Reconciliation",
    description: "Review procurement and financial discrepancies.",
    to: "/procurement/reconciliation",
  },
];

export function ProcurementOperationalWorkspace() {
  return (
    <section
      aria-label="Procurement operational workflow"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <div>
        <h2 className="text-lg font-semibold">
          Procurement operational workflow
        </h2>
        <p className="text-sm text-muted-foreground">
          Follow requirements through quotations, supplier orders,
          delivery and financial reconciliation.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {stages.map((stage, index) => (
          <Link
            key={stage.to}
            to={stage.to}
            className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
          >
            <span className="text-xs text-muted-foreground">
              Stage {index + 1}
            </span>
            <span className="mt-1 block text-sm font-semibold">
              {stage.title}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {stage.description}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}