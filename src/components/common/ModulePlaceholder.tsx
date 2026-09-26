import type { LucideIcon } from "lucide-react";
import { PageHeader } from "./DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { StatusPill } from "./DataDisplay";

/**
 * Placeholder scaffold for modules that will be implemented and wired to
 * Lovable Cloud in later steps.
 */
export function ModulePlaceholder({
  title,
  eyebrow,
  description,
  icon: Icon,
  capabilities,
  connections,
}: {
  title: string;
  eyebrow: string;
  description: string;
  icon: LucideIcon;
  capabilities: string[];
  connections: string[];
}) {
  return (
    <div>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="surface-panel lg:col-span-2">
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-primary-soft p-3 text-primary">
                <Icon className="size-5" />
              </span>
              <div>
                <p className="font-semibold">Planned capabilities</p>
                <p className="text-sm text-muted-foreground">
                  Scoped for this module — not yet implemented.
                </p>
              </div>
            </div>
            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {capabilities.map((c) => (
                <li
                  key={c}
                  className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
                >
                  {c}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="surface-panel">
          <CardContent className="p-6">
            <p className="font-semibold">Connected workflows</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Departments this module exchanges data with.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {connections.map((c) => (
                <StatusPill key={c} tone="info">
                  {c}
                </StatusPill>
              ))}
            </div>
            <div className="mt-6 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Backend, permissions and live data will be connected in a later step.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
