import {
  INSTALL_ACK_KEY,
  INSTALL_DISMISSED_KEY,
  readInstallPreference,
  saveInstallPreference,
  hasConfiguredDisplayOrStaffDevice,
} from "@/lib/install-preferences";
import { buildInfo, buildLabel } from "@/lib/build-info";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import {
  installInstructions,
  installPlatform,
  isInstallEntrance,
  type InstallPlatform,
} from "@/lib/app-install";

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type InstallContextValue = { installed: boolean; acknowledged: boolean; open: () => void };
const InstallContext = createContext<InstallContextValue | null>(null);
const DISMISSED = "neo.install.dismissed.v1";
const EARLY_CAPTURE = `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__neoInstallPrompt=e;});`;
export const APP_INSTALL_CAPTURE_SCRIPT = EARLY_CAPTURE;
declare global {
  interface Window {
    __neoInstallPrompt?: InstallEvent;
  }
}
export function AppInstallButton() {
  const install = useContext(InstallContext);
  if (!install || install.installed || install.acknowledged) return null;
  return (
    <Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={install.open}>
      <Download className="size-4" aria-hidden="true" />
      <span>Install app</span>
    </Button>
  );
}
export function AppInstallationProvider({ children }: { children: ReactNode }) {
  const { loading } = useAuth();
  const routerStatus = useRouterState({ select: (state) => state.status });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [installed, setInstalled] = useState(false),
    [open, setOpen] = useState(false),
    [prompt, setPrompt] = useState<InstallEvent | null>(null),
    [platform, setPlatform] = useState<InstallPlatform>("desktop"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const offered = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const configuredDevice = hasConfiguredDisplayOrStaffDevice();
    if (configuredDevice) saveInstallPreference(INSTALL_DISMISSED_KEY);
    setAcknowledged(readInstallPreference(INSTALL_ACK_KEY) || configuredDevice);
    const refresh = () => {
      const standalone =
        media.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      setInstalled(standalone);
      if (standalone) {
        saveInstallPreference(INSTALL_ACK_KEY);
        setAcknowledged(true);
      }
    };
    refresh();
    media.addEventListener("change", refresh);
    setPlatform(installPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints));
    if (window.__neoInstallPrompt) setPrompt(window.__neoInstallPrompt);
    const available = (event: Event) => {
      event.preventDefault();
      const install = event as InstallEvent;
      window.__neoInstallPrompt = install;
      setPrompt(install);
    };
    const complete = () => {
      saveInstallPreference(INSTALL_ACK_KEY);
      saveInstallPreference(INSTALL_DISMISSED_KEY);
      setAcknowledged(true);
      setInstalled(true);
      setOpen(false);
      setPrompt(null);
      delete window.__neoInstallPrompt;
    };
    window.addEventListener("beforeinstallprompt", available);
    window.addEventListener("appinstalled", complete);
    // The existing first-party worker handles push only; updating it does not reload forms.
    if (
      "serviceWorker" in navigator &&
      typeof navigator.serviceWorker?.getRegistrations === "function"
    ) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(
            registrations
              .filter((registration) => {
                const script =
                  registration.active?.scriptURL ??
                  registration.waiting?.scriptURL ??
                  registration.installing?.scriptURL;
                return (
                  script &&
                  new URL(script).origin === window.location.origin &&
                  new URL(script).pathname === "/worker-push-sw.js"
                );
              })
              .map((registration) => registration.update()),
          ),
        )
        .catch(() => {
          /* Existing notifications remain available if checking updates fails. */
        });
    }
    return () => {
      media.removeEventListener("change", refresh);
      window.removeEventListener("beforeinstallprompt", available);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);
  useEffect(() => {
    if (
      loading ||
      routerStatus !== "idle" ||
      !isInstallEntrance(pathname) ||
      installed ||
      acknowledged ||
      offered.current ||
      window.top !== window.self
    )
      return;
    try {
      if (readInstallPreference(INSTALL_DISMISSED_KEY) || sessionStorage.getItem(DISMISSED)) return;
    } catch {
      /* Storage may be restricted; keep the prompt usable. */
    }
    const timer = window.setTimeout(() => {
      // Never cover another dialog or a person who has already started typing.
      if (
        document.querySelector('[role="dialog"][data-state="open"]') ||
        document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')
      )
        return;
      offered.current = true;
      setOpen(true);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [loading, routerStatus, pathname, installed, acknowledged]);
  const close = useCallback(() => {
    setOpen(false);
    offered.current = true;
    try {
      sessionStorage.setItem(DISMISSED, "1");
      saveInstallPreference(INSTALL_DISMISSED_KEY);
    } catch {}
  }, []);
  async function requestInstall() {
    if (!prompt) return;
    setBusy(true);
    setMessage("");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      // Only appinstalled/display-mode confirms installation; acceptance is a request.
      setMessage(
        choice.outcome === "accepted"
          ? "Installation requested. Finish the browser’s installation steps."
          : "Installation was cancelled. You can continue using NEØ in this browser.",
      );
      setPrompt(null);
      delete window.__neoInstallPrompt;
    } catch {
      setMessage(
        "The browser could not open installation. Use the steps below or try again from your browser menu.",
      );
      setPrompt(null);
      delete window.__neoInstallPrompt;
    } finally {
      setBusy(false);
    }
  }
  return (
    <InstallContext.Provider
      value={{
        installed,
        acknowledged,
        open: () => {
          setMessage("");
          setOpen(true);
        },
      }}
    >
      {children}
      <Dialog
        open={open && !installed}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Install NEØ</DialogTitle>
            <DialogDescription>
              Open NEØ from your home screen, dock or desktop. The installed web app uses the
              current version deployed on this website.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {installInstructions(platform).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              An internet connection is required for hotel operations. Installing does not grant
              access or download hotel records for offline use. Sign in with your own authorised
              account.
            </p>
            <p className="break-all text-xs text-muted-foreground">
              {buildLabel()} · source {buildInfo.sourceId}
            </p>
            {message ? (
              <p role="status" className="text-sm">
                {message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                saveInstallPreference(INSTALL_ACK_KEY);
                setAcknowledged(true);
                close();
              }}
            >
              Already installed
            </Button>
            <Button type="button" variant="outline" onClick={close}>
              Continue in browser
            </Button>
            {prompt ? (
              <Button type="button" disabled={busy} onClick={() => void requestInstall()}>
                {busy ? "Opening installation…" : "Install app"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </InstallContext.Provider>
  );
}
