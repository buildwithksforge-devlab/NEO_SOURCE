export type ProductionMeasurement = {
  planned: number;
  gross: number;
  waste: number;
};

export function productionYield(input: ProductionMeasurement) {
  const { planned, gross, waste } = input;

  if (![planned, gross, waste].every(Number.isFinite)) {
    throw new Error("Production quantities must be finite numbers.");
  }

  if (planned <= 0) {
    throw new Error("Planned production must be above zero.");
  }

  if (gross < 0 || waste < 0 || waste > gross) {
    throw new Error("Invalid production or wastage quantity.");
  }

  const available = gross - waste;

  return {
    planned,
    gross,
    waste,
    available,
    variance: available - planned,
    yieldPercent: (available / planned) * 100,
    wastePercent: gross > 0 ? (waste / gross) * 100 : 0,
  };
}

export function productionIsExpired(
  useBy: string | null | undefined,
  now: number,
): boolean {
  if (!useBy) return false;

  const timestamp = Date.parse(useBy);

  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return true;
  }

  return timestamp < now;
}

export function productionCanBeMadeAvailable(input: {
  posted: boolean;
  planned: number;
  gross: number;
  waste: number;
  useBy?: string | null;
  now: number;
}): boolean {
  if (input.posted) return false;

  try {
    return (
      productionYield(input).available > 0 &&
      !productionIsExpired(input.useBy, input.now)
    );
  } catch {
    return false;
  }
}
