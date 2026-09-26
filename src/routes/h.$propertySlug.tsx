import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { supabase } from "@/integrations/supabase/client";
import { writePropertySelection } from "@/lib/property-selection";
import {
  entranceRefusal,
  enterProperty,
  resolvePropertyEntrance,
  type PropertyEntrance,
} from "@/lib/property-entrance";

export const Route = createFileRoute("/h/$propertySlug")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Hotel staff sign-in — NEØ" },
      {
        name: "description",
        content:
          "Sign in to your hotel on NEØ. Access is granted by your account, membership and property assignment.",
      },
      { property: "og:title", content: "Hotel staff sign-in — NEØ" },
      {
        property: "og:description",
        content: "Branded staff entrance for a single hotel on the NEØ hospitality platform.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PropertyEntrancePage,
});

function PropertyEntrancePage() {
  const { propertySlug } = Route.useParams();
  const [entrance, setEntrance] = useState<PropertyEntrance | null | "loading">("loading");

  useEffect(() => {
    let live = true;
    resolvePropertyEntrance(propertySlug)
      .then((r) => live && setEntrance(r))
      .catch(() => live && setEntrance(null));
    return () => {
      live = false;
    };
  }, [propertySlug]);

  if (entrance === "loading") {
    return (
      <AuthLayout title="Loading" subtitle="Opening this hotel's sign-in page…">
        <div className="flex justify-center py-10">
          <Loader2 className="size-6 animate-spin text-neo-turquoise" />
        </div>
      </AuthLayout>
    );
  }

  if (!entrance) {
    return (
      <AuthLayout
        title="Entrance not available"
        subtitle="This hotel address is not recognised, or its own entrance is switched off."
      >
        <p className="text-sm text-neo-steel">
          You can still sign in at the main NEØ sign-in page.{" "}
          <Link to="/auth" className="font-medium text-neo-aqua hover:underline">
            Go to sign in
          </Link>
          .
        </p>
      </AuthLayout>
    );
  }

  return <PropertySignIn entrance={entrance} />;
}

function PropertySignIn({ entrance }: { entrance: PropertyEntrance }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** Apply the property context only after the database confirms access. */
  async function completeEntry(userId: string) {
    const result = await enterProperty(entrance.branch_id);
    if (!result.allowed) {
      await supabase.auth.signOut();
      const message =
        entranceRefusal[result.reason] ?? "You do not have access to this hotel.";
      setFormError(message);
      toast.error(message);
      return;
    }
    writePropertySelection(userId, entrance.branch_id);
    toast.success(`Signed in — ${result.property_name}`);
    navigate({ to: "/workspace", replace: true });
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      setBusy(false);
      const message = "Unable to sign in. Check your credentials and try again.";
      setFormError(message);
      toast.error(message);
      return;
    }
    try {
      await completeEntry(data.user.id);
    } catch {
      setFormError("Unable to open this hotel right now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const location = [entrance.city, entrance.country].filter(Boolean).join(", ");

  return (
    <AuthLayout
      title={entrance.property_name}
      subtitle={`${entrance.organization_name}${location ? ` · ${location}` : ""}`}
      header={
        entrance.logo_url ? (
          <img
            src={entrance.logo_url}
            alt={`${entrance.property_name} logo`}
            className="mb-6 h-12 w-auto object-contain"
          />
        ) : null
      }
      footer={
        <p>
          Part of a group or work across several hotels?{" "}
          <Link to="/auth" className="font-medium text-neo-aqua hover:underline">
            Use the main NEØ sign-in
          </Link>
          .
        </p>
      }
    >
      <form onSubmit={handleSignIn} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="entrance-email" className="text-neo-midnight">
            Email address
          </Label>
          <Input
            id="entrance-email"
            type="email"
            autoComplete="email"
            required
            className="h-12 rounded-xl border-neo-mist bg-white text-neo-midnight focus-visible:border-neo-turquoise focus-visible:ring-neo-turquoise/40"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="entrance-password" className="text-neo-midnight">
            Password
          </Label>
          <div className="relative">
            <Input
              id="entrance-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              className="h-12 rounded-xl border-neo-mist bg-white pr-12 text-neo-midnight focus-visible:border-neo-turquoise focus-visible:ring-neo-turquoise/40"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
        </div>

        {formError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end">
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
            `Sign in to ${entrance.property_name}`
          )}
        </Button>
        <p className="text-xs text-neo-steel">
          This address only selects the hotel. Your access is decided by your account, hotel group
          membership, property assignment and permissions.
        </p>
      </form>
    </AuthLayout>
  );
}
