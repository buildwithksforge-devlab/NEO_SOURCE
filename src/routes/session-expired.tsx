import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/session-expired")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Session expired — NEØ" },
      { name: "description", content: "Your secure session timed out after a period of inactivity." },
      { property: "og:title", content: "Session expired — NEØ" },
      { property: "og:description", content: "Your secure session timed out after a period of inactivity." },
    ],
  }),
  component: SessionExpired,
});

function SessionExpired() {
  return (
    <AuthLayout title="Session expired" subtitle="You were signed out to keep guest data safe.">
      <div className="space-y-4">
        <Clock className="size-8 text-warning" />
        <p className="text-sm text-neo-steel">
          Your session ended after a period of inactivity. Sign in again to continue where you left
          off.
        </p>
        <Button asChild className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white">
          <Link to="/auth">Sign in again</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
