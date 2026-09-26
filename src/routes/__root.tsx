import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { TenantProvider } from "../lib/tenant";
import { SessionProvider } from "../lib/session";
import { AuthProvider, useAuth } from "../lib/auth";
import { completeLaunch, markLaunch, setLaunchState } from "../lib/launch-state";
import { Toaster } from "../components/ui/sonner";
import { BRAND_BOOT_SCRIPT } from "../lib/brand-cache";
import {
  LAUNCH_SPLASH_MARKUP,
  LAUNCH_SPLASH_SCRIPT,
  LAUNCH_SPLASH_STYLES,
} from "../lib/launch-splash";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "NEØ — Next-Generation Enterprise Operations" },
      {
        name: "description",
        content:
          "White-label hospitality operating system for hotels, lodges, resorts, restaurants and conference centres.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      // Private by default. Search visibility is opt-in: a public route sets
      // its own robots directive, which replaces this one by meta name.
      { name: "robots", content: "noindex, nofollow" },
      // One launch palette across the shell, the browser chrome and the
      // installed wrapper: #0B0D0F, never a default white.
      { name: "theme-color", content: "#0B0D0F" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "NEØ" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "application-name", content: "NEØ" },
      {
        name: "google-site-verification",
        content: "vPzfK-w5RUIk1CxKYHj5F36QkcAyjO3zcgN1KMyerJs",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@400;500;600;700&family=Instrument+Serif&display=swap",
      },
      { rel: "icon", href: "/favicon.ico?v=neo-3", sizes: "any" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg?v=neo-3" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png?v=neo-3" },
      { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png?v=neo-3" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png?v=neo-3" },
      { rel: "manifest", href: "/site.webmanifest?v=neo-3" },

    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Applies the cached tenant palette before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: BRAND_BOOT_SCRIPT }} />
        <style dangerouslySetInnerHTML={{ __html: LAUNCH_SPLASH_STYLES }} />
      </head>
      <body>
        {/* NEØ Pulse launch frame: part of the first server-rendered paint, so
            there is never a blank white frame before the application. */}
        <div dangerouslySetInnerHTML={{ __html: LAUNCH_SPLASH_MARKUP }} />
        <script dangerouslySetInnerHTML={{ __html: LAUNCH_SPLASH_SCRIPT }} />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * The launch coordinator's only exit point. The launch shell leaves once the
 * session has been restored, the router has settled on a destination and that
 * destination has painted a stable frame — never merely because the bundle
 * loaded. Offline and error launches still resolve, so nobody is stranded on
 * the splash.
 */
function LaunchGate() {
  const { loading } = useAuth();
  const routerStatus = useRouterState({ select: (s) => s.status });
  const destination = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    markLaunch({
      appMountedAt: Math.round(performance.now()),
      offlineState: typeof navigator !== "undefined" ? !navigator.onLine : false,
      coldOrWarmStart:
        (window as unknown as { __neoWarmStart?: boolean }).__neoWarmStart === true
          ? "warm"
          : "cold",
    });
  }, []);

  useEffect(() => {
    if (loading) {
      setLaunchState("restoring-session");
      return;
    }
    markLaunch({ sessionResolvedAt: Math.round(performance.now()) });
    if (routerStatus !== "idle") {
      setLaunchState("resolving-context");
      return;
    }
    markLaunch({ contextResolvedAt: Math.round(performance.now()) });
    // Two frames: the destination has committed and the browser has painted it
    // underneath the launch shell before the cross-fade starts.
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => completeLaunch(destination)),
    );
    return () => cancelAnimationFrame(frame);
  }, [loading, routerStatus, destination]);

  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <TenantProvider>
        <AuthProvider>
          <SessionProvider>
            <LaunchGate />
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <Outlet />
            <Toaster richColors position="top-right" />
          </SessionProvider>
        </AuthProvider>
      </TenantProvider>
    </QueryClientProvider>
  );
}
