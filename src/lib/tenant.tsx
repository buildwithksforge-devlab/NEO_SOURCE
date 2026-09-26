import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultTenantState,
  makeBranch,
  nowIso,
} from "./tenant-defaults";
import { useQueryClient } from "@tanstack/react-query";
import { loadTenant, resolveOrganizationId, saveTenant } from "./tenant-store";
import { toast } from "sonner";
import { clearBrandCache, preloadBrandImage, writeBrandCache } from "./brand-cache";
import { pickThemedLogo } from "./brand-image";
import {
  clearPropertySelection,
  readPropertySelection,
  writePropertySelection,
} from "./property-selection";

import { supabase } from "@/integrations/supabase/client";
import { fontOptions, type AppBranding, type AppKey, type Branch, type BrandSettings, type CommunicationTemplate, type ContactInfo, type DashboardPreferences, type DocumentTemplate, type Organization, type RegionalSettings, type TenantState } from "./tenant-types";




type TenantContextValue = {
  tenant: TenantState;
  hydrated: boolean;
  activeBranchId: string | "all";
  setActiveBranchId: (id: string | "all") => void;
  activeBranch: Branch | null;
  updateOrganization: (patch: Partial<Organization>) => void;
  updateContact: (patch: Partial<ContactInfo>) => void;
  updateBrand: (patch: Partial<BrandSettings>) => void;
  updateRegional: (patch: Partial<RegionalSettings>) => void;
  updateDashboard: (patch: Partial<DashboardPreferences>) => void;
  updateAppBranding: (key: AppKey, patch: Partial<AppBranding>) => void;
  updateCommunicationTemplate: (id: string, patch: Partial<CommunicationTemplate>) => void;
  resetCommunicationTemplate: (id: string) => void;
  updateDocumentTemplate: (id: string, patch: Partial<DocumentTemplate>) => void;
  resetDocumentTemplate: (id: string) => void;
  addBranch: (patch?: Partial<Branch>) => Branch;
  updateBranch: (id: string, patch: Partial<Branch>) => void;
  removeBranch: (id: string) => void;
  resetBrand: () => void;
  completeOnboarding: (draft: Partial<TenantState>) => void;
  resetTenant: () => void;
  replaceTenant: (next: TenantState) => void;
  setupProgress: SetupProgress;
};

export type SetupProgress = {
  overall: number;
  items: { key: string; label: string; done: boolean; detail: string }[];
};

const TenantContext = createContext<TenantContextValue | null>(null);

function computeProgress(t: TenantState): SetupProgress {
  const items = [
    {
      key: "profile",
      label: "Hotel profile",
      done: Boolean(t.organization.name && t.organization.legalName && t.organization.description),
      detail: t.organization.name || "Not started",
    },
    {
      key: "contact",
      label: "Contact information",
      done: Boolean(t.contact.address && t.contact.phonePrimary && t.contact.email),
      detail: t.contact.email || "Missing details",
    },
    {
      key: "brand",
      label: "Brand identity",
      done: Boolean(t.brand.logoLight || t.brand.logoDark),
      detail: t.brand.logoLight || t.brand.logoDark ? "Logo uploaded" : "No logo uploaded",
    },
    {
      key: "regional",
      label: "Regional configuration",
      done: Boolean(t.regional.country && t.regional.currency && t.regional.timezone),
      detail: `${t.regional.country} · ${t.regional.currency}`,
    },
    {
      key: "tax",
      label: "Tax & legal",
      done: Boolean(t.regional.taxId && t.regional.registrationNumber),
      detail: t.regional.taxId ? `${t.regional.taxIdLabel} on file` : "Tax identifier missing",
    },
    {
      key: "branches",
      label: "Branches",
      done: t.branches.length > 0,
      detail: `${t.branches.length} configured`,
    },
    {
      key: "dashboard",
      label: "Dashboard appearance",
      done: t.dashboard.widgets.some((w) => w.enabled),
      detail: `${t.dashboard.widgets.filter((w) => w.enabled).length} widgets enabled`,
    },
    {
      key: "communication",
      label: "Communication templates",
      done: t.communicationTemplates.some((c) => c.enabled),
      detail: `${t.communicationTemplates.filter((c) => c.enabled).length} active`,
    },
    {
      key: "documents",
      label: "Document templates",
      done: t.documentTemplates.some((d) => d.signatureName),
      detail: `${t.documentTemplates.length} templates ready`,
    },
  ];
  const done = items.filter((i) => i.done).length;
  return { overall: Math.round((done / items.length) * 100), items };
}

/** Snapshot of the persisted sections, used to detect real user edits. */
function persistSnapshot(state: TenantState) {
  return JSON.stringify({
    organization: {
      name: state.organization.name,
      legalName: state.organization.legalName,
      businessType: state.organization.businessType,
      description: state.organization.description,
      onboardingCompleted: state.organization.onboardingCompleted,
    },
    contact: state.contact,
    brand: state.brand,
    regional: state.regional,
    dashboard: state.dashboard,
    appBranding: state.appBranding,
    communicationTemplates: state.communicationTemplates,
    documentTemplates: state.documentTemplates,
  });
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<TenantState>(() => defaultTenantState());
  const [hydrated, setHydrated] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [activeBranchId, setActiveBranchIdState] = useState<string | "all">("all");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last state confirmed to be in the database for `organizationId`. */
  const lastPersisted = useRef<{ orgId: string | null; snapshot: string }>({
    orgId: null,
    snapshot: "",
  });
  const hydrationToken = useRef(0);
  /** Whose property selection we are reading and writing. */
  const sessionUserId = useRef<string | null>(null);
  const queryClient = useQueryClient();


  const cancelPendingSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }, []);

  /** Hydrate the workspace from the database for the signed-in tenant. */
  const hydrate = useCallback(async () => {
    const token = ++hydrationToken.current;
    // Any queued write belongs to the previous session/organization.
    cancelPendingSave();
    setHydrated(false);
    const orgId = await resolveOrganizationId();
    if (token !== hydrationToken.current) return;
    setOrganizationId(orgId);
    if (!orgId) {
      const empty = defaultTenantState();
      lastPersisted.current = { orgId: null, snapshot: persistSnapshot(empty) };
      setTenant(empty);
      setHydrated(true);
      return;
    }
    try {
      const next = await loadTenant(orgId, () =>
        queryClient.fetchQuery({
          // Same cache entry the property selector uses, so the workspace and
          // the selector never issue the same branch query twice.
          queryKey: ["branches", orgId],
          staleTime: 60_000,
          queryFn: async () => {
            const { data, error } = await supabase
              .from("branches")
              .select("*")
              .order("is_main", { ascending: false })
              .order("name", { ascending: true });
            if (error) throw error;
            return (data ?? []) as unknown as Record<string, unknown>[];
          },
        }),
      );
      if (token !== hydrationToken.current) return;
      lastPersisted.current = { orgId, snapshot: persistSnapshot(next) };
      setTenant(next);
      setHydrated(true);

    } catch {
      // Keep the last confirmed database version; never persist defaults over it.
      if (token !== hydrationToken.current) return;
      setHydrated(false);
    }
  }, [cancelPendingSave, queryClient]);

  useEffect(() => {
    // The working property belongs to the person, not the device: restore the
    // signed-in user's own selection rather than the last one used here.
    void supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id ?? null;
      sessionUserId.current = uid;
      const branch = readPropertySelection(uid);
      if (branch) setActiveBranchIdState(branch);
    });
    void hydrate();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        // The next person at this workstation starts from their own property.
        clearPropertySelection(sessionUserId.current);
        sessionUserId.current = null;
        setActiveBranchIdState("all");
        // Drop queued writes so a signed-out session cannot flush stale settings.
        hydrationToken.current += 1;
        cancelPendingSave();
        lastPersisted.current = { orgId: null, snapshot: "" };
        setOrganizationId(null);
        setHydrated(false);
        setTenant(defaultTenantState());
        clearBrandCache();
        return;
      }
      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        sessionUserId.current = session?.user?.id ?? null;
        const remembered = readPropertySelection(sessionUserId.current);
        if (remembered) setActiveBranchIdState(remembered);
        void hydrate();
      }
    });
    return () => {
      sub.subscription.unsubscribe();
      cancelPendingSave();
    };
  }, [hydrate, cancelPendingSave]);

  // Persist configuration changes back to the database (debounced).
  useEffect(() => {
    if (!hydrated || !organizationId) return;
    // The loaded state belongs to another organization — never cross-write.
    if (tenant.organization.id && tenant.organization.id !== organizationId) return;
    if (lastPersisted.current.orgId !== organizationId) return;

    const snapshot = persistSnapshot(tenant);
    // Hydration result is not a user edit.
    if (snapshot === lastPersisted.current.snapshot) return;

    cancelPendingSave();
    const orgAtEdit = organizationId;
    saveTimer.current = setTimeout(() => {
      void saveTenant(orgAtEdit, tenant)
        .then(() => {
          if (hydrationToken.current && organizationId === orgAtEdit) {
            lastPersisted.current = { orgId: orgAtEdit, snapshot };
          }
        })
        .catch((error: unknown) => {
          // Keep the previous confirmed snapshot so a retry re-attempts the write,
          // and tell the user — a silent failure here is what made an uploaded
          // logo look saved until the next refresh.
          console.error("[tenant] workspace save failed", error);
          toast.error(
            error instanceof Error && /payload|too large|413/i.test(error.message)
              ? "Workspace changes were not saved — the uploaded image is too large."
              : "Workspace changes could not be saved. Check your connection and try again.",
          );
        });
    }, 700);
    return cancelPendingSave;
  }, [tenant, hydrated, organizationId, cancelPendingSave]);



  // Apply tenant brand tokens to the document so every semantic class follows.
  // Layout effect + cached pre-paint script: the tenant palette is already on
  // screen for the first frame, so there is no neutral-theme flash.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const b = tenant.brand;
    const font = fontOptions.find((f) => f.key === b.fontKey) ?? fontOptions[0]!;

    const isDark = () =>
      b.theme === "dark" ||
      (b.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

    // Hue tokens are theme-independent. Surface tokens (background / foreground /
    // secondary) are the LIGHT palette only — applying them in dark mode would
    // beat the `.dark` block and leave a light dashboard on a dark shell.
    const applyTheme = () => {
      const dark = isDark();
      root.classList.toggle("dark", dark);
      root.style.setProperty("--brand", b.primary);
      root.style.setProperty("--brand-accent", b.accent);
      root.style.setProperty("--font-sans", font.stack);
      if (dark) {
        root.style.removeProperty("--secondary");
        root.style.removeProperty("--background");
        root.style.removeProperty("--foreground");
      } else {
        root.style.setProperty("--secondary", b.secondary);
        root.style.setProperty("--background", b.background);
        root.style.setProperty("--foreground", b.foreground);
      }
    };
    applyTheme();

    // Only remember a hydrated tenant palette, never the neutral defaults.
    if (hydrated) {
      writeBrandCache({
        primary: b.primary,
        accent: b.accent,
        secondary: b.secondary,
        background: b.background,
        foreground: b.foreground,
        font: font.stack,
        theme: b.theme,
        favicon: b.favicon ?? undefined,
        logo: pickThemedLogo(b.logoLight, b.logoDark, isDark()) ?? undefined,
      });
      preloadBrandImage(pickThemedLogo(b.logoLight, b.logoDark, isDark()));
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [tenant.brand, hydrated]);


  // Favicon follows tenant branding.
  useEffect(() => {
    if (!tenant.brand.favicon) return;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = tenant.brand.favicon;
  }, [tenant.brand.favicon]);

  const patchSection = useCallback(
    <K extends keyof TenantState>(key: K, patch: Partial<TenantState[K]>) => {
      setTenant((prev) => ({
        ...prev,
        [key]: { ...(prev[key] as object), ...patch, updatedAt: nowIso() },
      }));
    },
    [],
  );

  const value = useMemo<TenantContextValue>(() => {
    const branches = tenant.branches;
    const activeBranch = branches.find((b) => b.id === activeBranchId) ?? null;

    return {
      tenant,
      hydrated,
      activeBranchId,
      activeBranch,
      setActiveBranchId: (id) => {
        setActiveBranchIdState(id);
        writePropertySelection(sessionUserId.current, id);
      },
      updateOrganization: (patch) => patchSection("organization", patch),
      updateContact: (patch) =>
        setTenant((prev) => ({ ...prev, contact: { ...prev.contact, ...patch } })),
      updateBrand: (patch) => patchSection("brand", patch),
      updateRegional: (patch) => patchSection("regional", patch),
      updateDashboard: (patch) => patchSection("dashboard", patch),
      updateAppBranding: (key, patch) =>
        setTenant((prev) => ({
          ...prev,
          appBranding: {
            ...prev.appBranding,
            [key]: { ...prev.appBranding[key], ...patch, updatedAt: nowIso() },
          },
        })),
      updateCommunicationTemplate: (id, patch) =>
        setTenant((prev) => ({
          ...prev,
          communicationTemplates: prev.communicationTemplates.map((t) =>
            t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t,
          ),
        })),
      resetCommunicationTemplate: (id) =>
        setTenant((prev) => {
          const fresh = defaultTenantState().communicationTemplates.find((t) => t.id === id);
          if (!fresh) return prev;
          return {
            ...prev,
            communicationTemplates: prev.communicationTemplates.map((t) =>
              t.id === id ? fresh : t,
            ),
          };
        }),
      updateDocumentTemplate: (id, patch) =>
        setTenant((prev) => ({
          ...prev,
          documentTemplates: prev.documentTemplates.map((t) =>
            t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t,
          ),
        })),
      resetDocumentTemplate: (id) =>
        setTenant((prev) => {
          const fresh = defaultTenantState().documentTemplates.find((t) => t.id === id);
          if (!fresh) return prev;
          return {
            ...prev,
            documentTemplates: prev.documentTemplates.map((t) => (t.id === id ? fresh : t)),
          };
        }),
      addBranch: (patch) => {
        const branch = makeBranch({ isMain: tenant.branches.length === 0, ...patch });
        setTenant((prev) => ({ ...prev, branches: [...prev.branches, branch] }));
        return branch;
      },
      updateBranch: (id, patch) =>
        setTenant((prev) => ({
          ...prev,
          branches: prev.branches.map((b) =>
            b.id === id ? { ...b, ...patch, updatedAt: nowIso() } : b,
          ),
        })),
      removeBranch: (id) =>
        setTenant((prev) => ({ ...prev, branches: prev.branches.filter((b) => b.id !== id) })),
      resetBrand: () => setTenant((prev) => ({ ...prev, brand: defaultTenantState().brand })),
      completeOnboarding: (draft) =>
        setTenant((prev) => ({
          ...prev,
          ...draft,
          organization: {
            ...prev.organization,
            ...draft.organization,
            onboardingCompleted: true,
            updatedAt: nowIso(),
          },
        })),
      resetTenant: () => setTenant(defaultTenantState()),
      replaceTenant: (next) => setTenant({ ...defaultTenantState(), ...next }),
      setupProgress: computeProgress(tenant),
    };
  }, [tenant, hydrated, activeBranchId, patchSection]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenant must be used inside TenantProvider");
  return ctx;
}
