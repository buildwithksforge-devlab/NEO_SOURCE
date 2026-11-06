// Pending review/application: shared staff-shell navigation control.
import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BackNavigation() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav aria-label="Page navigation" className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 gap-2"
        aria-label={canGoBack ? "Go back" : "Back to workspace"}
        disabled={!canGoBack && pathname === "/workspace"}
        onClick={() => {
          if (canGoBack) router.history.back();
          else void router.navigate({ to: "/workspace", replace: true });
        }}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back
      </Button>
    </nav>
  );
}
