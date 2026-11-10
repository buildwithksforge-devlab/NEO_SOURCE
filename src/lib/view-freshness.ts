/** Active operational reads refresh across workers even without a delivered socket event. */
export const VISIBLE_VIEW_REFRESH = { refetchInterval: 15_000, refetchIntervalInBackground: false } as const;

type ViewAccess = {
 organizationId: string | null;
 user?: { id: string } | null;
 phase?: string;
 permissions?: Set<string>;
 permissionsLoaded?: boolean;
 accessLoaded?: boolean;
 access?: { accessScope?: string; branchIds?: string[]; departmentIds?: string[]; stationIds?: string[]; roleIds?: string[] };
};
/** Cache answers belong to the current worker and effective access, not just a workspace. */
export function readViewAccess(auth: ViewAccess) {
 const sorted = (values?: string[]) => [...(values ?? [])].sort();
 const identity = JSON.stringify({worker:auth.user?.id ?? null,permissions:[...(auth.permissions ?? [])].sort(),scope:auth.access?.accessScope,branches:sorted(auth.access?.branchIds),departments:sorted(auth.access?.departmentIds),stations:sorted(auth.access?.stationIds),roles:sorted(auth.access?.roleIds)});
 return { identity, ready: auth.phase === 'ready' && auth.permissionsLoaded === true && auth.accessLoaded === true && Boolean(auth.organizationId && auth.user?.id) };
}
