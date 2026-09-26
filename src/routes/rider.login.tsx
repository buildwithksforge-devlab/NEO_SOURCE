import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback } from "@/lib/public-apps";
import { GENERIC_AUTH_ERROR } from "@/lib/public-session";

export const Route = createFileRoute("/rider/login")({
  // A rider may arrive from a specific hotel's page. That intent is carried
  // here and replayed after sign-in, so the rider lands where they meant to go.
  validateSearch: (search: Record<string, unknown>): { next?: string | undefined } => ({
    next:
      typeof search["next"] === "string" &&
      search["next"].startsWith("/") &&
      !search["next"].startsWith("//")
        ? search["next"]
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Rider sign in — NEØ Rider App" },
      { name: "description", content: "Secure sign in for authorised delivery riders." },
      { property: "og:title", content: "Rider sign in — NEØ Rider App" },
      { property: "og:description", content: "Secure sign in for authorised delivery riders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RiderLogin,
});

function RiderLogin() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError(GENERIC_AUTH_ERROR);
      return;
    }
    void navigate({ href: next ?? "/rider", replace: true });
  }

  return (
    <div className="neo-pub flex min-h-screen flex-col items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-2xl">
        <h1 className="neo-pub-display text-3xl" style={{ color: brandFallback.secondary }}>
          Rider sign in
        </h1>
        <p className="mt-1 text-sm" style={{ color: brandFallback.steel }}>
          Use the staff account issued to you by the hotel. Rider accounts are created by
          management only.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="rider-email">Work email</Label>
            <Input
              id="rider-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rider-password">Password</Label>
            <div className="relative">
              <Input
                id="rider-password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={show ? "Hide password" : "Show password"}
                onClick={() => setShow((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: brandFallback.primary }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Sign in
          </button>
        </form>
      </div>
      <p className="mt-6 text-xs text-white/80">
        Powered by <span className="font-semibold">NEØ</span>
      </p>
    </div>
  );
}
