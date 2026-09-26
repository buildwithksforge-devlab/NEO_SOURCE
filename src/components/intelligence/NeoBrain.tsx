/**
 * The NEØ Brain: a restrained module network showing which parts of the
 * operation contributed to what is currently on screen. Decorative only —
 * it asserts nothing that the panels beside it do not already state.
 */
import { MODULE_LABEL, type NeoModule } from "@/lib/intelligence-types";

const ORDER: NeoModule[] = [
  "pms",
  "crm",
  "pos",
  "kitchen",
  "inventory",
  "procurement",
  "finance",
  "housekeeping",
  "events",
  "workforce",
  "delivery",
];

export function NeoBrain({
  active,
  caption = "Modules contributing to what you are reading.",
}: {
  active: NeoModule[];
  caption?: string;
}) {
  const set = new Set(active);
  const radius = 74;
  const centre = 92;

  return (
    <figure className="neo-brain rounded-2xl border border-outline-subtle p-4">
      <figcaption className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        NEØ Brain
      </figcaption>
      <svg
        viewBox="0 0 184 184"
        role="img"
        aria-label={`NEØ module network. Contributing modules: ${active.map((m) => MODULE_LABEL[m]).join(", ") || "none"}.`}
        className="mx-auto h-44 w-44"
      >
        {ORDER.map((m, i) => {
          const angle = (i / ORDER.length) * Math.PI * 2 - Math.PI / 2;
          const x = centre + radius * Math.cos(angle);
          const y = centre + radius * Math.sin(angle);
          const on = set.has(m);
          return (
            <g key={m}>
              <line
                x1={centre}
                y1={centre}
                x2={x}
                y2={y}
                stroke="currentColor"
                className={on ? "text-primary/70" : "text-muted-foreground/20"}
                strokeWidth={on ? 1.4 : 0.7}
              />
              <circle
                cx={x}
                cy={y}
                r={on ? 6 : 3.5}
                className={on ? "fill-primary" : "fill-muted-foreground/30"}
              />
              <title>{MODULE_LABEL[m]}</title>
            </g>
          );
        })}
        <circle cx={centre} cy={centre} r={16} className="fill-primary/15 stroke-primary/50" strokeWidth={1} />
        <text x={centre} y={centre + 4} textAnchor="middle" className="fill-primary text-[10px] font-semibold">
          NEØ
        </text>
      </svg>
      <p className="mt-1 text-center text-xs text-muted-foreground">{caption}</p>
      <ul className="mt-2 flex flex-wrap justify-center gap-1">
        {active.map((m) => (
          <li key={m} className="rounded-md bg-tint-accent px-2 py-0.5 text-[0.68rem] text-on-tint-accent">
            {MODULE_LABEL[m]}
          </li>
        ))}
      </ul>
    </figure>
  );
}
