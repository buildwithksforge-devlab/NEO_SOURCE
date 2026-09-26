import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";

export const Route = createFileRoute("/auth/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Set a new password — NEØ" },
      { name: "description", content: "Choose a new password for your hospitality workspace account." },
      { property: "og:title", content: "Set a new password — NEØ" },
      { property: "og:description", content: "Choose a new password for your hospitality workspace account." },
    ],
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await supabase.from("profiles").update({ must_change_password: false }).eq("id", data.user.id);
    }
    toast.success("Password updated");
    navigate({ to: "/workspace" });
  }

  return (
    <AuthLayout title="Set a new password" subtitle="Choose a strong password you have not used before.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pw">New password</Label>
          <Input id="pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw2">Confirm password</Label>
          <Input id="pw2" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white" disabled={busy}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
