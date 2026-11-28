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

export function productionDisplaySearch(search: Record<string, unknown>): { station?: string | undefined; property?: string | undefined } {
  return {
    station: typeof search["station"] === "string" ? search["station"] : undefined,
    property: typeof search["property"] === "string" ? search["property"] : undefined,
  };
}

export function stationAccountSignInPath(department: Exclude<DisplayDepartment, "overview">, property: string, station: string) {
  const search = new URLSearchParams({ property, station });
  return `/auth?${new URLSearchParams({ mode: "pin", redirect: `${DISPLAY_ROUTES[department]}?${search}` })}`;
}

export function stationSignInDestination(redirect: string | undefined) {
  if (!redirect?.startsWith("/")) return undefined;
  const origin = "https://station.invalid";
  let destination: URL;
  try { destination = new URL(redirect, origin); } catch { return undefined; }
  const routes: readonly string[] = [DISPLAY_ROUTES.kitchen, DISPLAY_ROUTES.bar, DISPLAY_ROUTES.coffee, DISPLAY_ROUTES.pastry];
  const station = destination.searchParams.get("station");
  const property = destination.searchParams.get("property");
  if (destination.origin !== origin || !routes.includes(destination.pathname) || !station || !property) return undefined;
  return { property, href: `${destination.pathname}?${new URLSearchParams({ property, station })}` };
}

// This classifies presentation only. RLS, the scoped station list and the
// existing transition RPC remain authoritative for access and execution.
export function stationDepartment(
  station: DisplayStation,
): Exclude<DisplayDepartment, "overview"> | null {
  const type = (station.station_type ?? "").trim().toLowerCase();

  // Service and support records must never enter production displays.
  if (type === "service" || type === "support") return null;

  // Explicit station identities are authoritative.
  if (
    type === "coffee" ||
    type === "pastry" ||
    type === "bar" ||
    type === "kitchen"
  ) {
    return type;
  }

  const department = (station.department_key ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");

  const label = `${station.code ?? ""} ${station.name}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  const isCoffee = /\b(coffee|barista)\b/.test(label);
  const isPastry = /\b(pastry|bakery|dessert)\b/.test(label);

  // Recognize the existing dedicated production departments.
  if (
    department === "pastry" ||
    department === "pastry-and-bakery"
  ) {
    return "pastry";
  }

  if (department === "coffee") return "coffee";

  // Existing coffee stations can belong to the Bar department.
  // Their specific production identity takes precedence over
  // the broader department classification.
  if (department === "bar") {
    return isCoffee ? "coffee" : "bar";
  }

  if (
    department === "main-kitchen" ||
    department === "kitchen"
  ) {
    return "kitchen";
  }

  // Existing coffee stations commonly belong to Food & Beverage.
  // Identify the production station without treating every F&B
  // service station as a production screen.
  if (
    department === "food-and-beverage" ||
    department === "food-beverage"
  ) {
    if (isCoffee) return "coffee";
    if (isPastry) return "pastry";

    if (type === "beverage") return "bar";

    return null;
  }

  // Do not infer production access from the name of a station
  // explicitly assigned to an unrelated department.
  if (department) return null;

  // Legacy stations without canonical department metadata.
  if (isCoffee) return "coffee";
  if (isPastry) return "pastry";

  if (type === "beverage" || /\b(bar|beverage)\b/.test(label)) {
    return "bar";
  }

  if (/\b(kitchen|grill|larder|pizza|fry|salad)\b/.test(label)) {
    return "kitchen";
  }

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
