export type DisplayDepartment = "kitchen" | "bar" | "coffee" | "pastry" | "overview";
export type DisplayStation = {
  id: string;
  name: string;
  code?: string | null;
  station_type?: string | null;
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
  const type = (station.station_type ?? "").toLowerCase();
  const label = `${station.code ?? ""} ${station.name}`.toLowerCase();
  if (type === "coffee" || /\b(coffee|barista)\b/.test(label)) return "coffee";
  if (type === "pastry" || /\b(pastry|bakery|dessert)\b/.test(label)) return "pastry";
  if (type === "bar" || type === "beverage" || /\b(bar|beverage)\b/.test(label)) return "bar";
  if (type === "kitchen" || /\b(kitchen|grill|pizza|fry|salad)\b/.test(label)) return "kitchen";
  return null;
}

export function displayStations(stations: DisplayStation[], department: DisplayDepartment) {
  return department === "overview"
    ? stations.filter((s) => s.station_type !== "service")
    : stations.filter((s) => stationDepartment(s) === department);
}

export function selectedDisplayStation(stations: DisplayStation[], requested: string | undefined) {
  // A bookmark cannot widen the server-scoped station list or select "all".
  return stations.find((s) => s.id === requested) ?? (requested ? undefined : stations[0]);
}
