import { useCallback } from "react";
import { useTenant } from "./tenant";
import { pickThemedLogo } from "./brand-image";
import { useIsDarkAppearance } from "./use-dark-appearance";

/**
 * Compatibility layer used by operational screens.
 * Branding always resolves from the active tenant record, so the whole app
 * stays white-label without each screen knowing about the tenant store.
 */
export function useBranding() {
  const { tenant, updateBrand } = useTenant();
  const brand = tenant.brand;
  const theme = brand.theme;
  const dark = useIsDarkAppearance(theme);

  const toggleTheme = useCallback(() => {
    updateBrand({ theme: theme === "dark" ? "light" : "dark" });
  }, [theme, updateBrand]);

  return {
    branding: {
      businessName: tenant.organization.name || "Not Configured",
      shortName: tenant.organization.name?.split(" ")[0] || "NEØ",
      tagline: "Next-Generation Enterprise Operations",
      logoText: brand.logoText || "NEØ",
      // Dark shells need the light-on-dark mark; fall back to whichever exists.
      logo: pickThemedLogo(brand.logoLight, brand.logoDark, dark),
      currency: tenant.regional.currency,
      country: tenant.regional.country,
      timezone: tenant.regional.timezone,
      taxLabel: tenant.regional.taxLabel,
      taxRate: tenant.regional.vatRate,
    },
    brand,
    setBrand: updateBrand,
    theme,
    setTheme: (t: "light" | "dark" | "system") => updateBrand({ theme: t }),
    toggleTheme,
  };
}
