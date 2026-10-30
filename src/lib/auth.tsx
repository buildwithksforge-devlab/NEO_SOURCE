import { guardedRpc } from "@/lib/rpc-guard";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { forgetContext } from "@/lib/continue-context";
import { toast } from "sonner";
import { clearPendingActions, replayPendingActions } from "@/lib/retry-after-reauth";
import { recoverMyWorkspace } from "@/lib/workspace-provisioning";
import {
  isPermissionDeniedError,
  recordRpcMetric,
  resolveExecutingRole,
  REAUTH_MESSAGE,
} from "@/lib/rpc-telemetry";
import {
  addGrant,
  canExactlyFromPermissions,
  canFromPermissions,
  canModuleFromPermissions,
} from "./permissions";
import {
  clearAccessCache,
  perfMark,
  readCachedAccess,
  recallOrganizationId,
  rememberOrganizationId,
  writeCachedAccess,
} from "./access-cache";
import {
  readPermissionFingerprint,
  resetPermissionFingerprint,
} from "./permission-fingerprint";



export type Profile = {
  id: string;
  organization_id: string;
  /** The group currently being worked in; null means the home group above. */
  active_organization_id?: string | null;
  full_name: string;
  staff_id: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  branch_id: string | null;
  department_id: string | null;
  job_title: string;
  employment_status: string;
  account_status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The signed-in employee's actual place of work, resolved by the same database
 * helpers the row-level policies use. Never derived from a role name in the UI.
 */
export type AccessContext = {
  accessScope: "organisation" | "branch" | "department" | "team" | "self" | "technical";
  branchIds: string[];
  departmentIds: string[];
  stationIds: string[];
  accountStatus: string | null;
  accountType: string | null;
  setupComplete: boolean;
  dashboardKey: string | null;
  entitlements: Record<string, boolean>;
  roleIds: string[];
  individualGrants: number;
  individualDenials: number;
};

const EMPTY_ACCESS: AccessContext = {
  accessScope: "self",
  branchIds: [],
  departmentIds: [],
  stationIds: [],
  accountStatus: null,
  accountType: null,
  setupComplete: false,
  dashboardKey: null,
  entitlements: {},
  roleIds: [],
  individualGrants: 0,
  individualDenials: 0,
};

/**
 * Stage 1 — one explicit protected-workspace state machine. The shell must not
 * mount a protected screen until this reaches `ready`, so a signing-in user can
 * never be shown the previous account's tenant, dashboard, roles or records.
 */
export type AuthPhase =
  | "signed-out"
  | "authenticating"
  | "resolving-account"
  | "resolving-access"
  | "ready"
  | "setup-incomplete"
  | "suspended"
  | "denied"
  /** Session missing or no longer authorised — the only remedy is a new sign-in. */
  | "reauth-required"
  | "error";

type AuthContextValue = {
  loading: boolean;
  phase: AuthPhase;
  /** Human-readable reason for a terminal, non-ready phase. */
  phaseDetail: string | null;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  organizationId: string | null;
  roleNames: string[];
  permissions: Set<string>;
  /** True once the effective-access resolver has answered for this session. */
  permissionsLoaded: boolean;
  isAdmin: boolean;
  /** Workplace scope (organisation, property, department, team or own work). */
  access: AccessContext;
  /** True once the workplace scope has been resolved for this session. */
  accessLoaded: boolean;
  /** True only for an incomplete Owner workspace attempt bound to this exact user. */
  canRecoverWorkspace: boolean;
  /** Explicitly completes the signed-in creator's own incomplete workspace. */
  recoverWorkspace: () => Promise<void>;
  /** `can(module, action)` or the feature-scoped `can(module, feature, action)`. */
  can: (module: string, actionOrFeature: string, action?: string) => boolean;
  /** Strict form for deliberately granted authorities; no action-class match. */
  canExact: (module: string, actionOrFeature: string, action?: string) => boolean;
  /** Module front door — true when the action is held on any feature of it. */
  canModule: (module: string, action?: string) => boolean;
  /** Module entitlement check — a permission cannot exceed the tenant's plan. */
  entitled: (featureKeyName: string) => boolean;

  refresh: () => Promise<void>;
  /** Re-reads effective access from the database without a full reload. */
  refreshPermissions: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Guest, delivery and rider surfaces are customer-facing products with their
 * own session model. They must never resolve a staff workspace (profile,
 * effective access, workspace link), never be redirected to the staff sign-in
 * screen, and never be signed out by the operator idle policy.
 */
const PUBLIC_SURFACE_PREFIXES = ["/guest/", "/delivery/", "/rider"];
function onPublicSurface() {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  if (path === "/station-screen") return true; // Restricted bearer-token device; no staff workspace.
  return PUBLIC_SURFACE_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
}
/** How often a live session checks whether its granted access changed. */
const PERMISSION_POLL_MS = 60 * 1000;

/** Tenant-scoped browser keys cleared on logout; device preferences survive. */
const TENANT_CACHE_PREFIXES = ["neo.tenant", "neo.branch", "neo.brand", "neo.workspace", "neo.preview"];

type EffectiveAccess = {
  user_id: string | null;
  account_type: string | null;
  account_status: string | null;
  organization_id: string | null;
  branch_ids: string[] | null;
  department_ids: string[] | null;
  station_ids: string[] | null;
  access_scope: AccessContext["accessScope"] | null;
  is_org_admin: boolean | null;
  role_ids: string[] | null;
  role_names: string[] | null;
  permissions: { module: string; feature: string | null; action: string }[] | null;
  individual_grants: unknown[] | null;
  individual_denials: unknown[] | null;
  entitlements: Record<string, boolean> | null;
  dashboard_key: string | null;
  setup_complete: boolean | null;
  state: "no_account" | "suspended" | "setup_incomplete" | "ready" | null;
  /** Precise reason a non-ready state occurred, so it can be acted on. */
  state_reason?: string | null;
  recoverable?: boolean | null;
  access_version: string | null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [access, setAccess] = useState<AccessContext>(EMPTY_ACCESS);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [canRecoverWorkspace, setCanRecoverWorkspace] = useState(false);
  const [phase, setPhase] = useState<AuthPhase>("authenticating");
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const bootstrapped = useRef(false);
  const permissionVersion = useRef<string | null>(null);
  const activeUserId = useRef<string | null>(null);
  /** One in-flight account resolution per user, shared by concurrent callers. */
  const inflightContext = useRef<{ userId: string; promise: Promise<void> } | null>(null);
  /** The user whose sign-in stamp has already been written in this tab. */
  const stampedFor = useRef<string | null>(null);


  /** Wipe every trace of the previous account before another one is resolved. */
  const clearWorkspaceState = useCallback(() => {
    setProfile(null);
    setRoleNames([]);
    setPermissions(new Set());
    setIsAdmin(false);
    setPermissionsLoaded(false);
    setAccess(EMPTY_ACCESS);
    setAccessLoaded(false);
    setCanRecoverWorkspace(false);
    setPhaseDetail(null);
    permissionVersion.current = null;
    try {
      supabase.removeAllChannels();
    } catch {
      /* realtime may not be connected */
    }
    queryClient.cancelQueries();
    queryClient.clear();
    try {
      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (TENANT_CACHE_PREFIXES.some((p) => key.startsWith(p))) window.localStorage.removeItem(key);
      }
      window.sessionStorage.clear();
      resetPermissionFingerprint();
      inflightContext.current = null;
      stampedFor.current = null;
      clearAccessCache();


    } catch {
      /* storage unavailable */
    }
  }, [queryClient]);

  /** Applies one effective-access contract to the workspace state machine. */
  const applyAccess = useCallback((a: EffectiveAccess) => {
    const set = new Set<string>();
    for (const row of a.permissions ?? []) addGrant(set, row.module, row.feature, row.action);
    setPermissions(set);
    setPermissionsLoaded(true);

    setRoleNames(a.role_names ?? []);
    setIsAdmin(Boolean(a.is_org_admin));
    setAccess({
      accessScope: a.access_scope ?? "self",
      branchIds: a.branch_ids ?? [],
      departmentIds: a.department_ids ?? [],
      stationIds: a.station_ids ?? [],
      accountStatus: a.account_status ?? null,
      accountType: a.account_type ?? null,
      setupComplete: Boolean(a.setup_complete),
      dashboardKey: a.dashboard_key ?? null,
      entitlements: a.entitlements ?? {},
      roleIds: a.role_ids ?? [],
      individualGrants: (a.individual_grants ?? []).length,
      individualDenials: (a.individual_denials ?? []).length,
    });
    setAccessLoaded(true);
    permissionVersion.current = a.access_version ?? null;
    setCanRecoverWorkspace(Boolean(a.recoverable));

    const reason = a.state_reason ?? null;
    const REASON_TEXT: Record<string, string> = {
      provisioning_incomplete:
        "Your workspace setup did not finish. It can be resumed — try again, or ask an administrator to complete it.",
      staff_record_missing: "No staff record is linked to this sign-in.",
      account_suspended: "This account is not active.",
      membership_missing: "Your staff record exists but is not linked to an organisation yet.",
      membership_inactive: "Your organisation membership is not active.",
      property_assignment_missing: "You have no property assignment yet.",
      role_missing: "No role has been assigned to your account yet.",
      department_assignment_missing: "You have no department assignment yet.",
    };

    switch (a.state) {
      case "suspended":
        setPhase("suspended");
        setPhaseDetail(`This account is ${a.account_status ?? "not active"}.`);
        break;
      case "no_account":
        setPhase("denied");
        setPhaseDetail(
          (reason && REASON_TEXT[reason]) ?? "No staff record is linked to this sign-in.",
        );
        break;
      case "setup_incomplete":
        setPhase("setup-incomplete");
        setPhaseDetail(
          (reason && REASON_TEXT[reason]) ?? "Your workplace assignment is not complete yet.",
        );
        break;
      default:
        setPhase("ready");
        setPhaseDetail(null);
    }
    perfMark("access:applied");
  }, []);

  /**
   * Effective access always comes from the same resolver the database uses for
   * RLS, so the interface can never offer an action the backend would refuse —
   * nor hide one it allows. Role names are never used to grant access.
   *
   * The contract is cached for the tab and revalidated against the cheap
   * permission fingerprint, so a returning session opens without waiting for
   * the full resolver — and still cannot run one moment on stale authority.
   */
  const loadAccess = useCallback(
    async (roleIdsFallback: string[], userId?: string | null) => {
      // Session guard: `my_permission_version` and `my_effective_access` are
      // authenticated routines. Dispatching them anonymously produces a
      // "permission denied for function" in the database log and an empty
      // workspace in the browser, so the anonymous case is refused here and
      // reported as what it is — a session that must be re-established.
      const executingRole = await resolveExecutingRole();
      if (executingRole !== "authenticated") {
        recordRpcMetric({
          rpc: "my_effective_access",
          required: "authenticated",
          role: executingRole,
          outcome: "auth_required",
          durationMs: 0,
          code: "no_session",
          message: "Access resolution attempted without an authenticated session.",
          at: Date.now(),
        });
        setPermissionsLoaded(true);
        setAccessLoaded(true);
        setPhase("reauth-required");
        setPhaseDetail(REAUTH_MESSAGE);
        return;
      }

      let servedFromCache = false;
      if (userId) {
        const cached = readCachedAccess<EffectiveAccess>(userId);
        if (cached) {
          applyAccess(cached.payload);
          servedFromCache = true;
          perfMark("access:cache-hit");
          // Revalidate cheaply; only re-resolve when authority actually changed.
          const { value: version, error: versionError } = await readPermissionFingerprint();
          if (!versionError && version === cached.version) {
            perfMark("access:revalidated");
            return;
          }

        }
      }

      if (!servedFromCache) setPhase("resolving-access");
      perfMark("access:fetch-start");
      const startedAt = Date.now();
      const { data, error } = await guardedRpc(supabase, "my_effective_access");
      recordRpcMetric({
        rpc: "my_effective_access",
        required: "authenticated",
        role: executingRole,
        outcome: error ? (isPermissionDeniedError(error) ? "permission_denied" : "error") : "ok",
        durationMs: Date.now() - startedAt,
        code: error?.code ?? null,
        message: error?.message ?? null,
        at: startedAt,
      });

      if (error || !data) {
        // A permission denial is not a transient failure and must not be
        // masked by the raw-role fallback: the only honest remedy is a fresh
        // sign-in, so say so instead of opening a half-empty workspace.
        if (isPermissionDeniedError(error)) {
          setPermissionsLoaded(true);
          setAccessLoaded(true);
          setPhase("reauth-required");
          setPhaseDetail(REAUTH_MESSAGE);
          return;
        }
        // Degrade gracefully rather than locking every screen: fall back to the
        // raw role grants, and say plainly that access could not be confirmed.
        if (servedFromCache) return;
        if (roleIdsFallback.length) {
          const { data: perms } = await supabase
            .from("role_permissions")
            .select("permissions(module, feature, action)")
            .in("role_id", roleIdsFallback);
          const set = new Set<string>();
          for (const row of perms ?? []) {
            const p = (
              row as unknown as {
                permissions: { module: string; feature: string | null; action: string } | null;
              }
            ).permissions;
            if (p) addGrant(set, p.module, p.feature, p.action);
          }
          setPermissions(set);
        }
        setPermissionsLoaded(true);
        setAccessLoaded(true);
        setPhase("error");
        setPhaseDetail(error?.message ?? "Access could not be confirmed.");
        return;
      }


      const a = data as unknown as EffectiveAccess;
      applyAccess(a);
      if (userId) writeCachedAccess(userId, a.access_version ?? null, a);
    },
    [applyAccess],
  );


  const runLoadContext = useCallback(
    async (activeUser: User) => {

      perfMark("login:context-start");
      setPhase("resolving-account");
      // Signing in READS authorisation and never writes it. Provisioning,
      // template application, role grants and workspace recovery are explicit
      // administrative operations — so an ordinary sign-in can no longer emit
      // `role.permission.granted` or `workspace.recovered` audit events
      // attributed to the employee who merely logged in.
      //
      // The profile read and the access contract are independent, so they are
      // resolved together rather than one after the other.
      const [{ data: prof }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", activeUser.id).maybeSingle(),
        loadAccess([], activeUser.id),
      ]);
      perfMark("login:profile-loaded");

      if (!prof && !bootstrapped.current) {
        bootstrapped.current = true;
        const { data: link } = await guardedRpc(supabase, "neo_workspace_link_status");
        const status = (link ?? null) as {
          attempt_recorded?: boolean;
          recoverable?: boolean;
        } | null;
        setCanRecoverWorkspace(Boolean(status?.recoverable));
        setPhase(status?.recoverable ? "setup-incomplete" : "denied");
        setPhaseDetail(
          status?.recoverable
            ? "Your workspace setup was interrupted. Resume it to complete your Owner access securely."
            : status?.attempt_recorded
              ? "This workspace attempt cannot be recovered by this account. Contact an authorised administrator."
            : "No staff record is linked to this sign-in yet. Ask an administrator to provision your account.",
        );
        return;
      }

      // Self-heal the identity chain: the profile row is the single record for a
      // signed-in user, so fill any blanks from the auth account rather than
      // rendering a generic placeholder anywhere in the UI. This touches display
      // fields and the last-login stamp only — never roles or permissions.
      const resolved = prof as Profile | null;
      if (resolved) {
        // Tenant boundary: if this account now resolves to a different
        // workspace than the one last seen in this browser, every cached
        // tenant-bound query (Finance journals, receivables, aggregates) is
        // from the previous organisation and must be discarded before the new
        // workspace renders anything.
        const previousOrg = recallOrganizationId(activeUser.id);
        const nextOrg = resolved.organization_id ?? null;
        if (previousOrg !== undefined && previousOrg !== null && previousOrg !== nextOrg) {
          clearWorkspaceState();
        }
        rememberOrganizationId(activeUser.id, nextOrg);
        setProfile(resolved);

        const meta = (activeUser.user_metadata ?? {}) as Record<string, string>;
        const patch: Record<string, string> = {};
        if (!resolved.full_name?.trim() && (meta["full_name"] || activeUser.email)) {
          patch["full_name"] = meta["full_name"] || (activeUser.email ?? "").split("@")[0]!;
        }
        if (!resolved.email?.trim() && activeUser.email) patch["email"] = activeUser.email;
        // The sign-in stamp is written at most once every fifteen minutes.
        // This context reloads on every token refresh and tab focus, and an
        // unconditional write turned a display-only timestamp into one of the
        // busiest writes in the workspace.
        const lastStamp = resolved.last_login_at ? Date.parse(resolved.last_login_at) : 0;
        const stampIsStale = !lastStamp || Date.now() - lastStamp > 15 * 60_000;
        // …and at most once per resolved session in this tab, so a repeated
        // account resolution cannot issue the same write again.
        if (stampIsStale && stampedFor.current !== activeUser.id) {
          stampedFor.current = activeUser.id;
          patch["last_login_at"] = new Date().toISOString();
        }

        // The workspace is already usable; the stamp is written in the
        // background so it never delays the first screen.
        if (Object.keys(patch).length > 0) {
          void supabase
            .from("profiles")
            .update(patch as never)
            .eq("id", activeUser.id)
            .select("*")
            .maybeSingle()
            .then(({ data: updated }) => {
              if (updated) setProfile(updated as unknown as Profile);
            });
        }
      } else {
        setProfile(null);
      }
      perfMark("login:ready");
    },
    [loadAccess, clearWorkspaceState],
  );

  /**
   * One account resolution at a time.
   *
   * The initial session arrives twice — once from the explicit session read on
   * mount and once from the auth state listener — and both used to resolve the
   * whole account, so every workspace opened with two profile reads and two
   * effective-access resolutions. Concurrent callers for the same user now
   * share one resolution. This changes nothing about what is resolved: a
   * different user, or a later deliberate reload, still resolves afresh.
   */
  const loadContext = useCallback(
    (activeUser: User) => {
      // A guest or rider opening their own app is not a staff sign-in.
      if (onPublicSurface()) {
        setPhase("signed-out");
        return Promise.resolve();
      }
      const existing = inflightContext.current;
      if (existing && existing.userId === activeUser.id) return existing.promise;
      const promise = runLoadContext(activeUser).finally(() => {
        if (inflightContext.current?.promise === promise) inflightContext.current = null;
      });
      inflightContext.current = { userId: activeUser.id, promise };
      return promise;
    },
    [runLoadContext],
  );


  const refreshPermissions = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    // Authority is being re-resolved deliberately: no shared fingerprint answer
    // may survive into the new contract.
    resetPermissionFingerprint();
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("role_id")
      .eq("user_id", auth.user.id);
    await loadAccess(
      (roleRows ?? []).map((r) => (r as { role_id: string }).role_id),
      auth.user.id,
    );
  }, [loadAccess]);



  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    if (data.session?.user) {
      activeUserId.current = data.session.user.id;
      await loadContext(data.session.user);
    } else {
      activeUserId.current = null;
      setPhase("signed-out");
    }
    setLoading(false);
  }, [loadContext]);

  const recoverWorkspace = useCallback(async () => {
    setLoading(true);
    setPhase("resolving-account");
    try {
      await recoverMyWorkspace();
      clearAccessCache();
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error(REAUTH_MESSAGE);
      bootstrapped.current = false;
      await loadContext(data.user);
    } catch (error) {
      setPhase("setup-incomplete");
      setPhaseDetail(error instanceof Error ? error.message : "Workspace setup could not be resumed.");
      throw error;
    } finally {
      setLoading(false);
    }
  }, [loadContext]);

  useEffect(() => {
    let cancelled = false;

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      setSession(nextSession);
      if (event === "SIGNED_OUT") {
        activeUserId.current = null;
        clearWorkspaceState();
        clearPendingActions();
        setPhase("signed-out");
        /**
         * A lapsed or unrefreshable session also arrives here. Without leaving
         * the workspace route the mounted screens keep refetching anonymously,
         * and every tenant-scoped query answers "permission denied for
         * function current_org_id" instead of a clean sign-in prompt. Leave
         * for the sign-in screen once, keeping the intended destination.
         */
        if (typeof window !== "undefined" && !onPublicSurface() && !window.location.pathname.startsWith("/auth")) {
          const redirect = `${window.location.pathname}${window.location.search}`;
          navigate({ to: "/auth", search: { redirect }, replace: true });
        }
        return;
      }
      if (event === "SIGNED_IN") {
        /**
         * An action refused because the session had lapsed is replayed here,
         * so an operator who signs in again does not have to rebuild the
         * dispatch decision they had already made.
         */
        setTimeout(() => {
          void replayPendingActions().then(({ replayed }) => {
            if (replayed) toast.success(`Resumed ${replayed} action${replayed === 1 ? "" : "s"} after sign-in`);
          });
        }, 0);
      }
      if (nextSession?.user) {
        const switched = activeUserId.current !== null && activeUserId.current !== nextSession.user.id;
        if (switched) clearWorkspaceState();
        if (event === "TOKEN_REFRESHED" && !switched) return;
        activeUserId.current = nextSession.user.id;
        setPhase("authenticating");
        // Defer async work out of the auth callback.
        setTimeout(() => {
          void loadContext(nextSession.user).finally(() => setLoading(false));
        }, 0);
      }
    });

    void refresh();
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadContext, refresh, clearWorkspaceState, navigate]);

  const signOut = useCallback(async () => {
    // Cleanup must finish before any other workspace can be mounted.
    setPhase("signed-out");
    // A remembered entrance must never survive a deliberate sign-out.
    forgetContext();
    await supabase.auth.signOut();
    clearWorkspaceState();
    activeUserId.current = null;
    navigate({ to: "/auth", replace: true });
  }, [navigate, clearWorkspaceState]);

  // Automatic session timeout after inactivity.
  useEffect(() => {
    if (!session || onPublicSurface()) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void supabase.auth.signOut().then(() => {
          clearWorkspaceState();
          navigate({ to: "/session-expired" });
        });
      }, IDLE_TIMEOUT_MS);
    };
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [session, navigate, clearWorkspaceState]);

  // Permission changes made by an administrator must reach a live session
  // without a logout. A cheap fingerprint is polled and on tab focus; a full
  // reload only happens when that fingerprint actually changed.
  useEffect(() => {
    if (!session || onPublicSurface()) return;
    let cancelled = false;
    const check = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      const { value: next, error } = await readPermissionFingerprint();
      if (error || cancelled) return;

      if (permissionVersion.current !== null && next !== permissionVersion.current) {
        await refreshPermissions();
      } else {
        permissionVersion.current = next;
      }
    };
    const timer = setInterval(() => void check(), PERMISSION_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [session, refreshPermissions]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      phase,
      phaseDetail,
      session,
      user: session?.user ?? null,
      profile,
      // The group being worked in. A person with one membership is unaffected;
      // a multi-group member follows their selected workspace, exactly as the
      // database access rules resolve it.
      organizationId: profile?.active_organization_id ?? profile?.organization_id ?? null,
      roleNames,
      permissions,
      permissionsLoaded,
      isAdmin,
      access,
      accessLoaded,
      canRecoverWorkspace,
      recoverWorkspace,
      // Authority comes from granted permissions only. There is no name-based
      // bypass here: an administrator sees what their roles actually grant, so
      // the UI, Role Testing and the database policies all agree.
      can: canFromPermissions(permissions),
      canExact: canExactlyFromPermissions(permissions),
      canModule: canModuleFromPermissions(permissions),
      entitled: (featureKeyName: string) => {
        const value = access.entitlements[featureKeyName];
        return value === undefined ? true : value;
      },

      refresh,
      refreshPermissions,
      signOut,
    }),
    [
      loading,
      phase,
      phaseDetail,
      session,
      profile,
      roleNames,
      permissions,
      permissionsLoaded,
      isAdmin,
      access,
      accessLoaded,
      canRecoverWorkspace,
      recoverWorkspace,
      refresh,
      refreshPermissions,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
