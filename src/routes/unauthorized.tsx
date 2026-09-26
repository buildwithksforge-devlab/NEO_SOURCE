import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/unauthorized")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Access denied — NEØ" },
      { name: "description", content: "You do not have permission to open this area of the workspace." },
      { property: "og:title", content: "Access denied — NEØ" },
      { property: "og:description", content: "You do not have permission to open this area of the workspace." },
    ],
  }),
  component: Unauthorized,
});

function Unauthorized() {
  return (
    <AuthLayout
      title="Access denied"
      subtitle="Your role does not include permission for this area."
    >
      <div className="space-y-5">
        <ShieldAlert className="size-8 text-destructive" />
        <p className="text-sm text-neo-steel">
          Ask an owner or system administrator to grant access.
        </p>
        <Button
          asChild
          className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white"
        >
          <Link to="/workspace">Back to dashboard</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
