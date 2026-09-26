import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";

export const Route = createFileRoute("/auth/forgot-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Reset your password — NEØ" },
      { name: "description", content: "Request a secure password reset link for your staff account." },
      { property: "og:title", content: "Reset your password — NEØ" },
      { property: "og:description", content: "Request a secure password reset link for your staff account." },
    ],
  }),
  component: ForgotPassword,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
    toast.success("Reset link sent");
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="We'll email you a secure link to set a new one."
      footer={
        <Link to="/auth" className="font-medium text-neo-aqua hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="rounded-xl bg-neo-mist/60 p-5 text-sm">
          <p className="font-medium">Check your inbox</p>
          <p className="mt-2 text-neo-steel">
            If an account exists for {email}, a password reset link is on its way. The link expires
            after one hour.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
