import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth/verify-email")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Verify your email — NEØ" },
      { name: "description", content: "Confirm your email address to activate your staff account." },
      { property: "og:title", content: "Verify your email — NEØ" },
      { property: "og:description", content: "Confirm your email address to activate your staff account." },
    ],
  }),
  component: VerifyEmail,
});

function VerifyEmail() {
  return (
    <AuthLayout title="Verify your email" subtitle="One more step before you can sign in.">
      <div className="space-y-4">
        <MailCheck className="size-8 text-primary" />
        <p className="text-sm text-neo-steel">
          We've sent a confirmation link to your inbox. Open it on this device to activate your
          account, then sign in to your workspace.
        </p>
        <Button asChild className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white">
          <Link to="/auth">Continue to sign in</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
