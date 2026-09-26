/**
 * NEØ CONTINUE — the canonical post-sign-in resolver.
 *
 * Signing in proves who someone is. This screen decides what they are here
 * as, from relationships that already exist: employment, a business
 * relationship, a rider registration, or real stays. It never manufactures a
 * guest context out of a login.
 *
 * One relationship opens straight away. Several show a chooser. A remembered
 * choice is restored only after it is found again in the freshly resolved
 * list. None at all leaves the person on Discover, signed in, with a profile
 * and a way to sign out.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bike, Briefcase, Handshake, Loader2, LogOut, UtensilsCrossed } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";
import { Display, Eyebrow, PublicPanel, PublicSurface } from "@/components/public/NeoPublic";
import {
  forgetContext,
  readRememberedContext,
  rememberContext,
  resolveMyContexts,
  revalidateRemembered,
  type ContextKind,
  type NeoContext,
} from "@/lib/continue-context";

export const Route = createFileRoute("/continue")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { choose?: string } =>
    String(search["choose"] ?? "") === "1" ? { choose: "1" } : {},
  head: () => ({
    meta: [
      { title: "Choose how to continue — NEØ" },
      {
        name: "description",
        content: "Open the hotel workspace, guest app, partner portal or rider app you belong to.",
      },
      { property: "og:title", content: "Choose how to continue — NEØ" },
      { property: "og:description", content: "Your NEØ entrances, resolved from real relationships." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ContinueScreen,
});

const ICONS: Record<ContextKind, typeof Briefcase> = {
  work: Briefcase,
  guest: UtensilsCrossed,
  partner: Handshake,
  rider: Bike,
};

function ContinueScreen() {
  const navigate = useNavigate();
  const router = useRouter();
  const search = Route.useSearch() as { choose?: string };
  // "Switch context" asks for the chooser explicitly; anything else may auto-open.
  const switching = search?.choose === "1";
  const [name, setName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let live = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (!live) return;
      const user = data.user;
      if (!user) {
        void navigate({ to: "/auth", replace: true });
        return;
      }
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      setName(
        (typeof meta["full_name"] === "string" && meta["full_name"]) ||
          user.email ||
          null,
      );
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [navigate]);

  const contexts = useQuery({
    queryKey: ["neo-my-contexts"],
    queryFn: resolveMyContexts,
    enabled: checked,
    staleTime: 30_000,
  });

  const list = useMemo(() => contexts.data ?? [], [contexts.data]);

  // Automatic opening happens only when the person did not ask to switch.
  useEffect(() => {
    if (switching || !contexts.isSuccess) return;
    const restored = revalidateRemembered(list, readRememberedContext());
    const only = list.length === 1 ? list[0]! : null;
    const target = restored ?? only;
    if (target) {
      rememberContext(target.key);
      router.navigate({ href: target.route, replace: true });
      return;
    }
    if (list.length === 0) router.navigate({ to: "/", replace: true });
  }, [switching, contexts.isSuccess, list, router]);

  function open(ctx: NeoContext) {
    rememberContext(ctx.key);
    router.navigate({ href: ctx.route, replace: true });
  }

  async function signOut() {
    forgetContext();
    await supabase.auth.signOut();
    void navigate({ to: "/auth", replace: true });
  }

  const busy = !checked || contexts.isPending;

  return (
    <PublicSurface className="pb-0">
      <header className="neo-pub-header">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center gap-4 px-5">
          <img src={NEO_WORDMARK_SRC} alt="NEØ" width={88} height={20} className="h-5 w-auto object-contain" />
          <div className="ml-auto flex items-center gap-3">
            {name ? (
              <span className="max-w-[10rem] truncate text-xs text-white/70 sm:max-w-[16rem]">{name}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void signOut()}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-white/20 px-4 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-14">
        <Eyebrow>Signed in</Eyebrow>
        <Display className="mt-4 text-[2.2rem] sm:text-5xl">Choose how to continue</Display>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/65">
          These are the entrances already attached to your account. Opening one remembers it for
          next time; you can switch whenever you like.
        </p>

        {busy ? (
          <div className="mt-10 flex items-center gap-3 text-sm text-white/60">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Resolving your access…
          </div>
        ) : contexts.isError ? (
          <PublicPanel className="mt-10 p-6">
            <p className="text-sm text-white/80">
              Your entrances could not be loaded just now. Try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => void contexts.refetch()}
              className="mt-4 inline-flex h-10 items-center rounded-full bg-white px-5 text-xs font-semibold text-[#020A1C]"
            >
              Try again
            </button>
          </PublicPanel>
        ) : list.length === 0 ? (
          <PublicPanel className="mt-10 p-6">
            <p className="text-sm text-white/80">
              Your account does not hold a workspace, guest, partner or rider relationship yet. A
              hotel administrator adds staff and partners; a guest context appears once you have a
              booking or an order.
            </p>
          </PublicPanel>
        ) : (
          <ul className="mt-10 grid gap-4 sm:grid-cols-2">
            {list.map((ctx) => {
              const Icon = ICONS[ctx.kind];
              return (
                <li key={ctx.key}>
                  <button
                    type="button"
                    onClick={() => open(ctx)}
                    className="group flex h-full w-full flex-col items-start gap-3 rounded-2xl border border-white/12 bg-white/[0.04] p-5 text-left transition-colors hover:border-neo-turquoise/60 hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neo-turquoise"
                  >
                    <span className="grid size-10 place-items-center rounded-full bg-neo-turquoise/15 text-neo-turquoise">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="text-xs uppercase tracking-[0.18em] text-white/50">
                      {ctx.label}
                    </span>
                    <span className="text-lg font-semibold leading-tight text-white">
                      {ctx.propertyName}
                    </span>
                    {ctx.organizationName ? (
                      <span className="text-xs text-white/50">{ctx.organizationName}</span>
                    ) : null}
                    <span className="text-sm leading-relaxed text-white/65">{ctx.detail}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </PublicSurface>
  );
}
