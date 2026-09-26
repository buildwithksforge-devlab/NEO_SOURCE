import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTenant } from "@/lib/tenant";
import { documentTypeLabels } from "@/lib/tenant-defaults";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/documents")({
  head: () => ({
    meta: [
      { title: "Document Branding — System Administration" },
      {
        name: "description",
        content:
          "Design branded invoices, receipts, quotations, purchase orders and statements with headers, banking details, terms and signatures.",
      },
      { property: "og:title", content: "Document Branding — System Administration" },
      { property: "og:description", content: "Branded business document templates." },
    ],
  }),
  component: DocumentsPage,
});

function DocumentsPage() {
  const { tenant, updateDocumentTemplate } = useTenant();
  const [activeId, setActiveId] = useState(tenant.documentTemplates[0]?.id ?? "");
  const doc = tenant.documentTemplates.find((t) => t.id === activeId) ?? tenant.documentTemplates[0];

  if (!doc) return null;

  return (
    <div>
      <PageHeader
        eyebrow="Branding"
        title="Business Documents"
        description="Every printed or emailed document carries the same brand system."
        actions={
          <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Changes save automatically
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <SectionCard title="Document types" description={`${tenant.documentTemplates.length} templates`}>
          <ul className="space-y-1">
            {tenant.documentTemplates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(t.id)}
                  className={cn(
                    "w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    doc.id === t.id ? "bg-primary-soft font-medium text-primary" : "hover:bg-muted",
                  )}
                >
                  {documentTypeLabels[t.type]}
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <SectionCard title="Header" description="Logo placement and heading text">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Header text</Label>
                  <Input
                    value={doc.headerText}
                    onChange={(e) => updateDocumentTemplate(doc.id, { headerText: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Logo placement</Label>
                  <div className="flex gap-2">
                    {(["left", "center", "right"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => updateDocumentTemplate(doc.id, { logoPlacement: p })}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-sm capitalize",
                          doc.logoPlacement === p
                            ? "border-primary bg-primary-soft text-primary"
                            : "border-border hover:bg-muted",
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                {(
                  [
                    ["showLogo", "Show logo"],
                    ["showCompanyInfo", "Show company & tax details"],
                    ["showQr", "Show verification QR code"],
                    ["showBanking", "Show banking details"],
                    ["showSignature", "Show signature block"],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm"
                  >
                    {label}
                    <Switch
                      checked={doc[key]}
                      onCheckedChange={(v) => updateDocumentTemplate(doc.id, { [key]: v })}
                    />
                  </label>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Footer content" description="Banking, terms and signatures">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Banking details</Label>
                  <Textarea
                    rows={3}
                    value={doc.bankingDetails}
                    onChange={(e) =>
                      updateDocumentTemplate(doc.id, { bankingDetails: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Terms & conditions</Label>
                  <Textarea
                    rows={3}
                    value={doc.terms}
                    onChange={(e) => updateDocumentTemplate(doc.id, { terms: e.target.value })}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Signatory name</Label>
                    <Input
                      value={doc.signatureName}
                      onChange={(e) =>
                        updateDocumentTemplate(doc.id, { signatureName: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Signatory title</Label>
                    <Input
                      value={doc.signatureTitle}
                      onChange={(e) =>
                        updateDocumentTemplate(doc.id, { signatureTitle: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Footer text</Label>
                  <Input
                    value={doc.footerText}
                    onChange={(e) => updateDocumentTemplate(doc.id, { footerText: e.target.value })}
                  />
                </div>
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Preview" description="A4 document layout">
            <div className="space-y-3 rounded-xl border border-border bg-card p-5 text-xs shadow-elegant">
              <div
                className={cn(
                  "flex items-center gap-3 border-b border-border pb-3",
                  doc.logoPlacement === "center" && "justify-center text-center",
                  doc.logoPlacement === "right" && "flex-row-reverse text-right",
                )}
              >
                {doc.showLogo ? (
                  tenant.brand.logoLight ? (
                    <img src={tenant.brand.logoLight} alt="" className="h-9 object-contain" />
                  ) : (
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                      {tenant.brand.logoText}
                    </span>
                  )
                ) : null}
                <div>
                  <p className="text-sm font-semibold">{tenant.organization.name || "Your hotel"}</p>
                  {doc.showCompanyInfo ? (
                    <p className="text-muted-foreground">
                      {tenant.contact.address || "Business address"} · {tenant.regional.taxIdLabel}:{" "}
                      {tenant.regional.taxId || "—"}
                    </p>
                  ) : null}
                </div>
              </div>

              <p className="text-sm font-semibold uppercase tracking-wide">{doc.headerText}</p>

              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 font-medium">Description</th>
                    <th className="py-1 text-right font-medium">Qty</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Deluxe room — 3 nights", "3", "45,000"],
                    ["Dinner, à la carte", "2", "6,400"],
                  ].map(([d, q, a]) => (
                    <tr key={d} className="border-b border-border/60">
                      <td className="py-1">{d}</td>
                      <td className="py-1 text-right">{q}</td>
                      <td className="py-1 text-right">
                        {tenant.regional.currencySymbol} {a}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex justify-end gap-6">
                <span className="text-muted-foreground">
                  {tenant.regional.taxLabel} {tenant.regional.vatRate}%
                </span>
                <span className="font-semibold">{tenant.regional.currencySymbol} 51,400</span>
              </div>

              {doc.showBanking ? (
                <p className="whitespace-pre-line text-muted-foreground">{doc.bankingDetails}</p>
              ) : null}
              {doc.terms ? (
                <p className="whitespace-pre-line text-muted-foreground">{doc.terms}</p>
              ) : null}

              <div className="flex items-end justify-between pt-2">
                {doc.showSignature ? (
                  <div>
                    <div className="mb-1 h-6 w-28 border-b border-border" />
                    <p className="font-medium">{doc.signatureName}</p>
                    <p className="text-muted-foreground">{doc.signatureTitle}</p>
                  </div>
                ) : (
                  <span />
                )}
                {doc.showQr ? (
                  <div className="grid size-14 grid-cols-4 gap-0.5">
                    {Array.from({ length: 16 }).map((_, i) => (
                      <span
                        key={i}
                        className={cn("rounded-[1px]", i % 3 === 0 ? "bg-foreground" : "bg-muted")}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              <p className="border-t border-border pt-2 text-center text-muted-foreground">
                {doc.footerText}
              </p>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
