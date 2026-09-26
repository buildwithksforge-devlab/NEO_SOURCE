import { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { BrandButton, useWorkspace } from "@/components/public/PublicAppShell";
import { ensureCustomerRecord, GENERIC_AUTH_ERROR } from "@/lib/public-session";
import { brandFallback } from "@/lib/public-apps";
import { buildCustomerSignupMetadata } from "@/lib/auth-email-metadata";

type Mode = "signin" | "register" | "forgot";

/**
 * Customer authentication for the public apps. Registration only ever creates a
 * customer: no staff, department, manager or administrator access is possible
 * from here, and the email provider never influences the account type.
 */
export function CustomerAuthPanel({
  onSignedIn,
  initialMode = "signin",
}: {
  onSignedIn?: () => void;
  initialMode?: Mode;
}) {
  const ws = useWorkspace();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw new Error(GENERIC_AUTH_ERROR);
        await ensureCustomerRecord({
          organizationId: ws.organization_id,
          branchId: ws.branch_id,
          fullName: fullName || "",
          phone: phone || "",
        });
        toast.success("Signed in");
        onSignedIn?.();
      } else if (mode === "register") {
        if (!fullName.trim()) throw new Error("Enter your full name.");
        if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
            // Guests receive the branded confirmation with their own name and
            // the public brand only — never staff placement or role metadata.
            data: buildCustomerSignupMetadata({
              full_name: fullName,
              organisation_name: ws.hotel_name || ws.app_name,
              property_name: ws.hotel_name || null,
            }),
          },
        });
        if (signUpError) throw new Error(signUpError.message);
        if (data.session) {
          await ensureCustomerRecord({
            organizationId: ws.organization_id,
            branchId: ws.branch_id,
            fullName,
            phone,
          });
          toast.success("Account created");
          onSignedIn?.();
        } else {
          setNotice(
            "Check your inbox to verify your email address, then sign in to finish setting up your account.",
          );
        }
      } else {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/reset-password`,
        });
        if (resetError) throw new Error(GENERIC_AUTH_ERROR);
        setNotice("If that email is registered, a reset link is on its way.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_AUTH_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-black/5 bg-white p-6">
      <div className="flex gap-2 text-sm">
        {(["signin", "register"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
              setNotice(null);
            }}
            className="px-3 py-1.5 font-medium"
            style={{
              borderRadius: 999,
              background: mode === m ? `${ws.primary_color}1a` : "transparent",
              color: mode === m ? ws.primary_color : brandFallback.steel,
            }}
          >
            {m === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="mt-5 space-y-4">
        {mode === "register" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cust-name">Full name</Label>
              <Input
                id="cust-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-phone">Phone number</Label>
              <Input
                id="cust-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
          </>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="cust-email">Email address</Label>
          <Input
            id="cust-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        {mode !== "forgot" ? (
          <div className="space-y-1.5">
            <Label htmlFor="cust-password">Password</Label>
            <div className="relative">
              <Input
                id="cust-password"
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="text-sm" style={{ color: ws.primary_color }}>
            {notice}
          </p>
        ) : null}

        <BrandButton type="submit" disabled={busy} className="w-full">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "signin" ? "Sign in" : mode === "register" ? "Create account" : "Send reset link"}
        </BrandButton>

        <button
          type="button"
          onClick={() => setMode(mode === "forgot" ? "signin" : "forgot")}
          className="w-full text-center text-xs underline-offset-2 hover:underline"
          style={{ color: brandFallback.steel }}
        >
          {mode === "forgot" ? "Back to sign in" : "Forgot your password?"}
        </button>
      </form>
    </div>
  );
}
