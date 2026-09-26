import { Link } from "@tanstack/react-router";
import { Check, Minus, UserCog, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { useVisibility } from "@/lib/visibility";
import { assignmentChainFor, type VisibilityFacts } from "@/lib/visibility-contract";

/**
 * An employee is operationally active only once the permanent assignment chain
 * is complete: Organisation → Property → Department → Role → Station/Section →
 * Reporting Manager → Record Scope. Until then the workspace shows exactly
 * which link is missing rather than empty cards that read as a broken product.
 */
export function WorkplaceSetupNotice() {
  const { access, accessLoaded, isAdmin, loading } = useAuth();
  const visibility = useVisibility();

  if (loading || !accessLoaded || isAdmin) return null;

  const chain = assignmentChainFor(visibility.facts as VisibilityFacts);
  // Only a link that genuinely stops work raises this notice. An outstanding
  // reporting line is a data-quality task an administrator clears in their own
  // time; it must not tell someone their account needs setting up while the
  // same account is happily granted its operational workspace.
  if (chain.operationallyActive && (access.setupComplete || chain.missing.length === 0))
    return null;

  return (
    <div className="mb-6 rounded-2xl border border-border bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserCog className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Account setup required</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your account is active but your workplace assignment is not complete, so no
            operational work reaches it yet. An administrator completes the steps marked below.
          </p>
          <ul className="mt-4 space-y-2">
            {chain.steps
              .filter((step) => step.blocking || step.status !== "missing")
              .map((step) => (
              <li key={step.key} className="flex items-start gap-2 text-sm">
                <span
                  aria-hidden
                  className={
                    step.status === "complete"
                      ? "mt-0.5 text-success"
                      : step.status === "missing"
                        ? "mt-0.5 text-destructive"
                        : "mt-0.5 text-muted-foreground"
                  }
                >
                  {step.status === "complete" ? (
                    <Check className="size-4" />
                  ) : step.status === "missing" ? (
                    <X className="size-4" />
                  ) : (
                    <Minus className="size-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{step.label}</span>
                  <span className="sr-only">
                    {step.status === "complete"
                      ? " complete"
                      : step.status === "missing"
                        ? " outstanding"
                        : " not required"}
                  </span>
                  <span className="text-muted-foreground"> — {step.detail}</span>
                </span>
              </li>
              ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/notifications">Contact an administrator</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
