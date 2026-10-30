import { useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { awaitAuthenticatedUser, provisionWorkspace } from "@/lib/workspace-provisioning";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";
import {
  CreateWorkspaceWizard,
  PENDING_WORKSPACE_KEY,
} from "@/components/auth/CreateWorkspaceWizard";
import { cn } from "@/lib/utils";
import { canonicalUrl, PRODUCTION_ORIGIN } from "@/lib/route-visibility";

type AuthSearch = { redirect?: string | undefined; mode?: string | undefined };

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): AuthSearch => ({
    redirect: typeof search["redirect"] === "string" ? search["redirect"] : undefined,
    mode: search["mode"] === "create" ? "create" : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in or create a workspace — NEØ" },
      {
        name: "description",
        content:
          "Sign in to your NEØ workspace, or create a new workspace for your hotel, lodge, resort or restaurant.",
      },
      { property: "og:title", content: "Sign in or create a workspace — NEØ" },
      {
        property: "og:description",
        content:
          "Secure staff sign-in and workspace creation for the NEØ hospitality operating system.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/auth") },
      { property: "og:image", content: `${PRODUCTION_ORIGIN}/neo-social-preview.jpg` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${PRODUCTION_ORIGIN}/neo-social-preview.jpg` },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/auth") }],
  }),
  component: AuthPage,
});

const LOCK_KEY = "hos.failedLogins";
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const GENERIC_ERROR = "Unable to sign in. Check your credentials and try again.";

function readLock() {
  try {
    return JSON.parse(window.localStorage.getItem(LOCK_KEY) ?? "{}") as {
      count?: number;
      until?: number;
    };
  } catch {
    return {};
  }
}

function AuthPage() {
  const search = useSearch({ from: "/auth" });
  const [tab, setTab] = useState<"signin" | "create">(
    search.mode === "create" ? "create" : "signin",
  );

  return (
    <AuthLayout
      wide={tab === "create"}
      header={
        <div
          role="tablist"
          aria-label="Authentication options"
          className="mb-7 flex gap-6 border-b border-neo-mist"
        >
          {(
            [
              ["signin", "Sign In"],
              ["create", "Create Workspace"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neo-turquoise",
                tab === key
                  ? "border-neo-turquoise text-neo-midnight"
                  : "border-transparent text-neo-steel hover:text-neo-midnight",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
      title={tab === "signin" ? "Welcome back" : "Create your workspace"}
      subtitle={
        tab === "signin"
          ? "Sign in to your NEØ workspace."
          : "For a new hotel, restaurant, lodge, resort or hospitality business joining NEØ."
      }
      footer={
        tab === "signin" ? (
          <p>
            New hospitality business?{" "}
            <button
              type="button"
              onClick={() => setTab("create")}
              className="font-medium text-neo-aqua hover:underline"
            >
              Create a workspace
            </button>
            . Employees are added or invited by an authorised workspace administrator.
          </p>
        ) : null
      }
    >
      {tab === "signin" ? <SignInForm redirect={search.redirect} /> : <CreateWorkspaceWizard />}
    </AuthLayout>
  );
}

function SignInForm({ redirect }: { redirect?: string | undefined }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const lock = readLock();
    if (lock.until && lock.until > Date.now()) {
      const mins = Math.ceil((lock.until - Date.now()) / 60000);
      const msg = `Account temporarily locked. Try again in ${mins} minute(s).`;
      setFormError(msg);
      toast.error(msg);
      return;
    }
    setBusy(true);
    const { error, data } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);

    if (error) {
      const count = (lock.count ?? 0) + 1;
      const payload =
        count >= MAX_ATTEMPTS ? { count: 0, until: Date.now() + LOCK_MINUTES * 60000 } : { count };
      window.localStorage.setItem(LOCK_KEY, JSON.stringify(payload));
      const msg =
        count >= MAX_ATTEMPTS
          ? `Too many failed attempts. Locked for ${LOCK_MINUTES} minutes.`
          : `${GENERIC_ERROR} (${MAX_ATTEMPTS - count} attempt(s) left)`;
      setFormError(msg);
      toast.error(msg);
      return;
    }

    window.localStorage.removeItem(LOCK_KEY);
    if (!remember) window.sessionStorage.setItem("hos.rememberMe", "false");

    if (data.user) {
      // Sign-in is strictly read-only for authorization: it never creates,
      // replaces or promotes a role on its own. The only exception is the
      // workspace this same person explicitly submitted on this device before
      // email verification — it is completed once, idempotently, and the
      // backend still refuses to provision an account that already holds any
      // role or an organisation that already has members.
      const pending = window.localStorage.getItem(PENDING_WORKSPACE_KEY);
      if (pending) {
        // Resume the creator's own draft only after the session is applied and
        // the server confirms the user; the attempt is idempotent, so a retry
        // returns the existing workspace instead of duplicating anything.
        const verifiedId = await awaitAuthenticatedUser();
        if (verifiedId) {
          try {
            const payload = JSON.parse(pending) as { business_name?: string };
            const key = `${email.trim().toLowerCase()}::${(payload.business_name ?? "").trim().toLowerCase()}`;
            await provisionWorkspace(payload as Record<string, unknown>, key);
            window.localStorage.removeItem(PENDING_WORKSPACE_KEY);
          } catch {
            // A failed resume never blocks sign-in and never discards the
            // draft; the workspace gate reports the state and can retry.
          }
        }
      }

      // The sign-in stamp is written once by the workspace bootstrap, which
      // throttles it; repeating it here added a blocking write to every login.
    }

    toast.success("Signed in");
    // The intended destination may carry its own question marks (an entrance
    // on a hotel's page, for example), so it is replayed as a whole address.
    // Only same-origin paths are ever honoured.
    const target =
      redirect && redirect.startsWith("/") && !redirect.startsWith("//")
        ? redirect
        : // No explicit destination: the canonical resolver decides, from the
          // relationships this account genuinely holds. Authentication alone
          // never implies a guest, and never implies work either.
          "/continue";
    navigate({ href: target, replace: true });
  }

  return (
    <form onSubmit={handleSignIn} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email" className="text-neo-midnight">
          Email address
        </Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          className="h-12 rounded-xl border-neo-mist bg-white text-neo-midnight focus-visible:border-neo-turquoise focus-visible:ring-neo-turquoise/40"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="text-xs text-neo-steel">Use the email connected to your NEØ account.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password" className="text-neo-midnight">
          Password
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            className="h-12 rounded-xl border-neo-mist bg-white pr-12 text-neo-midnight focus-visible:border-neo-turquoise focus-visible:ring-neo-turquoise/40"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={(e) => setCapsLock(e.getModifierState?.("CapsLock") ?? false)}
            onKeyDown={(e) => setCapsLock(e.getModifierState?.("CapsLock") ?? false)}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-neo-steel transition-colors hover:text-neo-aqua focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neo-turquoise"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {capsLock ? <p className="text-xs font-medium text-neo-gold">Caps Lock is on.</p> : null}
      </div>

      {formError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-neo-steel">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(Boolean(v))}
            aria-label="Remember me"
          />
          Remember me
        </label>
        <Link
          to="/auth/forgot-password"
          className="rounded text-sm font-medium text-neo-aqua hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neo-turquoise"
        >
          Forgot password?
        </Link>
      </div>

      <Button
        type="submit"
        disabled={busy}
        className="h-12 w-full rounded-xl bg-neo-turquoise text-base font-semibold text-neo-midnight transition-colors hover:bg-neo-aqua hover:text-neo-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neo-turquoise"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Signing in…
          </>
        ) : (
          "Sign In"
        )}
      </Button>
      <div
        data-neo-station-display-entry
        className="mt-5 space-y-3 border-t border-neo-mist pt-5"
      >
        <p className="text-center text-sm font-medium text-neo-midnight">
          Kitchen, Coffee, Bar &amp; Pastry
        </p>

        <Link
          to="/station-screen"
          className="flex min-h-12 w-full items-center justify-center rounded-xl border border-neo-turquoise bg-white px-4 text-center text-sm font-semibold text-neo-midnight transition-colors hover:bg-neo-mist"
        >
          Open Paired Production Display
        </Link>

        <p className="text-center text-xs text-neo-steel">
          Paired Kitchen, Coffee, Bar and Pastry screens show incoming work without
          a staff workspace login. Each action requires only your personal PIN.
          Supervisors pair screens from Production Displays inside NEØ.
        </p>
      </div>
    </form>
  );
}
