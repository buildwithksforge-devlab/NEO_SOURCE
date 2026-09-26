import type { BrandSettings } from "@/lib/tenant-types";
import { fontOptions } from "@/lib/tenant-types";

/**
 * Static mock of the product chrome, rendered entirely from a draft brand
 * record so administrators can preview changes before saving them.
 */
export function BrandPreview({
  brand,
  businessName,
  branchName,
}: {
  brand: BrandSettings;
  businessName: string;
  branchName: string;
}) {
  const font = fontOptions.find((f) => f.key === brand.fontKey) ?? fontOptions[0]!;

  return (
    <div
      className="overflow-hidden rounded-xl border border-border shadow-elegant"
      style={{ fontFamily: font.stack, background: brand.background, color: brand.foreground }}
    >
      <div className="flex">
        <div
          className="hidden w-40 shrink-0 flex-col gap-2 p-3 sm:flex"
          style={{ background: brand.primary, color: "#fff" }}
        >
          <div className="flex items-center gap-2">
            {brand.logoLight ? (
              <img src={brand.logoLight} alt="" className="size-7 rounded-md bg-white/15 object-contain p-0.5" />
            ) : (
              <span
                className="flex size-7 items-center justify-center rounded-md text-[0.6rem] font-bold"
                style={{ background: brand.accent, color: "#1b1b1b" }}
              >
                {brand.logoText || "HOS"}
              </span>
            )}
            <span className="truncate text-[0.66rem] font-semibold">
              {businessName || "Your hotel"}
            </span>
          </div>
          {["Dashboard", "Front Office", "Restaurant", "Housekeeping", "Reports"].map((item, i) => (
            <div
              key={item}
              className="rounded-md px-2 py-1.5 text-[0.62rem]"
              style={
                i === 0
                  ? { background: "rgba(255,255,255,0.18)", fontWeight: 600 }
                  : { opacity: 0.75 }
              }
            >
              {item}
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="flex items-center justify-between border-b px-3 py-2"
            style={{ borderColor: "rgba(0,0,0,0.08)", background: brand.secondary }}
          >
            <span className="text-[0.65rem] font-medium opacity-70">{branchName}</span>
            <span
              className="rounded-full px-2 py-0.5 text-[0.58rem] font-semibold"
              style={{ background: brand.accent, color: "#1b1b1b" }}
            >
              Live preview
            </span>
          </div>

          <div className="space-y-2 p-3">
            <p className="text-sm font-semibold">Today at a glance</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Occupancy", "82%"],
                ["Revenue", "1.24M"],
                ["Arrivals", "34"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border p-2"
                  style={{ borderColor: "rgba(0,0,0,0.08)", background: "#ffffff" }}
                >
                  <p className="text-[0.55rem] opacity-60">{label}</p>
                  <p className="text-xs font-semibold" style={{ color: brand.primary }}>
                    {value}
                  </p>
                </div>
              ))}
            </div>
            <div
              className="flex h-16 items-end gap-1 rounded-lg border p-2"
              style={{ borderColor: "rgba(0,0,0,0.08)", background: "#ffffff" }}
            >
              {[40, 62, 48, 74, 90, 66, 82].map((h, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-sm"
                  style={{
                    height: `${h}%`,
                    background: i % 2 ? brand.accent : brand.primary,
                    opacity: 0.85,
                  }}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <span
                className="rounded-md px-2 py-1 text-[0.6rem] font-medium"
                style={{ background: brand.primary, color: "#fff" }}
              >
                New reservation
              </span>
              <span
                className="rounded-md border px-2 py-1 text-[0.6rem] font-medium"
                style={{ borderColor: brand.primary, color: brand.primary }}
              >
                Night audit
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
