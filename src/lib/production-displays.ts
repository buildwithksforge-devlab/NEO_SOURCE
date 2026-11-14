export type DisplayDepartment = "kitchen" | "bar" | "coffee" | "pastry" | "overview";
export type DisplayStation = {
  id: string;
  name: string;
  code?: string | null;
  station_type?: string | null;
  department_key?: string | null;
};

export const DISPLAY_ROUTES = {
  kitchen: "/kitchen/display",
  bar: "/bar/display",
  coffee: "/coffee/display",
  pastry: "/pastry/display",
  overview: "/production-overview",
} as const;

export const DISPLAY_LABELS: Record<DisplayDepartment, string> = {
  kitchen: "Kitchen Display",
  bar: "Bar Display",
  coffee: "Coffee Display",
  pastry: "Pastry Display",
  overview: "Production Overview",
};

// This classifies presentation only. RLS, the scoped station list and the
// existing transition RPC remain authoritative for access and execution.
export function stationDepartment(
  station: DisplayStation,
): Exclude<DisplayDepartment, "overview"> | null {
  const type = (station.station_type ?? "").trim().toLowerCase();
  if (type === "service" || type === "support") return null;
  // Explicit display types win over incidental words in a station's label.
  if (type === "coffee" || type === "pastry" || type === "bar" || type === "kitchen") return type;
  const configuredDepartment = (station.department_key ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (configuredDepartment === "main-kitchen" || configuredDepartment === "kitchen") return "kitchen";
  if (configuredDepartment === "bar" || configuredDepartment === "coffee" || configuredDepartment === "pastry") return configuredDepartment;
  // An explicit unrelated department must not become a production display
  // merely because its label happens to contain Coffee, Bar or Kitchen.
  if (configuredDepartment) return null;
  const label = `${station.code ?? ""} ${station.name}`.toLowerCase().replace(/[_-]+/g, " ");
  // Legacy beverage stations include the existing Coffee Station configuration.
  if (/\b(coffee|barista)\b/.test(label)) return "coffee";
  if (/\b(pastry|bakery|dessert)\b/.test(label)) return "pastry";
  if (type === "beverage" || /\b(bar|beverage)\b/.test(label)) return "bar";
  if (/\b(kitchen|grill|larder|pizza|fry|salad)\b/.test(label)) return "kitchen";
  return null;
}

export function displayStations(stations: DisplayStation[], department: DisplayDepartment) {
  return department === "overview"
    ? stations.filter((s) => !["service", "support"].includes(s.station_type?.trim().toLowerCase() ?? ""))
    : stations.filter((s) => stationDepartment(s) === department);
}

export function selectedDisplayStation(stations: DisplayStation[], requested: string | undefined) {
  // A bookmark cannot widen the server-scoped station list or select "all".
  return stations.find((s) => s.id === requested) ?? (requested ? undefined : stations[0]);
}

/** Keep newly configured/disabled stations in sync with the existing scoped reads. */
export const STATION_READ_QUERY_KEYS = [
  ["operational-stations"], ["pos", "stations"], ["kitchen", "stations"],
  ["kitchen", "scoped-stations"], ["kitchen", "visible-station-ids"], ["scope", "stations"],
] as const;

export async function invalidateStationReads(cache: { invalidateQueries: (input: { queryKey: readonly string[] }) => unknown }) {
  await Promise.all(STATION_READ_QUERY_KEYS.map((queryKey) => cache.invalidateQueries({ queryKey })));
}

export function displayStationFromRow<T extends DisplayStation & { departments?: { catalogue_key?: string | null } | null }>(station: T): T & { department_key: string | null } {
  return { ...station, department_key: station.departments?.catalogue_key ?? null };
}
