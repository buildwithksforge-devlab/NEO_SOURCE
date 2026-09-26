import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useBranchScope } from "./branches";

export type SessionUser = {
  name: string;
  initials: string;
  property: string;
};

export type Property = { id: string; name: string; type: string };

type SessionContextValue = {
  user: SessionUser;
  property: Property;
  properties: Property[];
  setPropertyId: (id: string) => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Workspace scope session. Properties are the live Supabase branch records the
 * signed-in user is authorized to see — nothing is hardcoded or stored locally
 * beyond the user's chosen active property.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { branches, orgWide, activeBranchId, activeBranch, setActiveBranchId } = useBranchScope();

  const value = useMemo<SessionContextValue>(() => {
    const properties: Property[] = [
      ...(orgWide ? [{ id: "all", name: "All Properties", type: "Organization" }] : []),
      ...branches.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.is_main ? "Main property" : "Property",
      })),
    ];
    const property = properties.find((p) => p.id === activeBranchId) ??
      properties[0] ?? { id: "none", name: "No property configured", type: "Organization" };

    return {
      user: {
        name: "",
        initials: "",
        property: activeBranch?.name ?? property.name,
      },
      property,
      properties,
      setPropertyId: setActiveBranchId,
    };
  }, [branches, orgWide, activeBranchId, activeBranch, setActiveBranchId]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
