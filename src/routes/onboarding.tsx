import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColorField, FieldGrid, ImageUploadField } from "@/components/common/FormFields";
import { useTenant } from "@/lib/tenant";
import { makeBranch } from "@/lib/tenant-defaults";
import {
  businessTypeLabels,
  type Branch,
  type BusinessType,
} from "@/lib/tenant-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Hotel Onboarding — HOS White-Label Setup" },
      {
        name: "description",
        content:
          "Guided onboarding for hospitality businesses: business details, branding, regional settings, tax information and branches.",
      },
      { property: "og:title", content: "Hotel Onboarding — HOS White-Label Setup" },
      {
        property: "og:description",
        content: "Set up your property, branding, regional configuration and branches in minutes.",
      },
    ],
  }),
  component: OnboardingWizard,
});

const steps = [
  { key: "business", title: "Business details", blurb: "Tell us about your property" },
  { key: "branding", title: "Branding", blurb: "Logo, favicon and colours" },
  { key: "contact", title: "Contact", blurb: "How guests reach you" },
  { key: "regional", title: "Regional", blurb: "Country, currency and formats" },
  { key: "tax", title: "Tax & legal", blurb: "Statutory identifiers" },
  { key: "branches", title: "Branches", blurb: "Properties you operate" },
  { key: "review", title: "Review", blurb: "Confirm and finish" },
];

const countries = [
  { name: "Kenya", currency: "KES", symbol: "KSh", tz: "Africa/Nairobi", taxLabel: "VAT", taxId: "KRA PIN", rate: 16 },
  { name: "Tanzania", currency: "TZS", symbol: "TSh", tz: "Africa/Dar_es_Salaam", taxLabel: "VAT", taxId: "TIN", rate: 18 },
  { name: "Uganda", currency: "UGX", symbol: "USh", tz: "Africa/Kampala", taxLabel: "VAT", taxId: "TIN", rate: 18 },
  { name: "Rwanda", currency: "RWF", symbol: "FRw", tz: "Africa/Kigali", taxLabel: "VAT", taxId: "TIN", rate: 18 },
  { name: "South Africa", currency: "ZAR", symbol: "R", tz: "Africa/Johannesburg", taxLabel: "VAT", taxId: "VAT Number", rate: 15 },
  { name: "United Arab Emirates", currency: "AED", symbol: "د.إ", tz: "Asia/Dubai", taxLabel: "VAT", taxId: "TRN", rate: 5 },
  { name: "United Kingdom", currency: "GBP", symbol: "£", tz: "Europe/London", taxLabel: "VAT", taxId: "VAT Number", rate: 20 },
];

function OnboardingWizard() {
  const navigate = useNavigate();
  const { tenant, completeOnboarding } = useTenant();
  const [step, setStep] = useState(0);
  const [organization, setOrganization] = useState(tenant.organization);
  const [contact, setContact] = useState(tenant.contact);
  const [brand, setBrand] = useState(tenant.brand);
  const [regional, setRegional] = useState(tenant.regional);
  const [multiBranch, setMultiBranch] = useState(tenant.branches.length > 1);
  const [branches, setBranches] = useState<Branch[]>(
    tenant.branches.length
      ? tenant.branches
      : [makeBranch({ name: "", isMain: true, code: "MAIN" })],
  );

  const current = steps[step]!;
  const progress = Math.round(((step + 1) / steps.length) * 100);

  const patchBranch = (id: string, patch: Partial<Branch>) =>
    setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const finish = () => {
    completeOnboarding({
      organization,
      contact,
      brand,
      regional,
      branches: branches.filter((b) => b.name.trim().length > 0),
    });
    toast.success("Setup complete", { description: "Your white-label workspace is ready." });
    navigate({ to: "/admin" });
  };

  const canContinue = (() => {
    if (current.key === "business") return organization.name.trim().length > 1;
    if (current.key === "branches") return branches.some((b) => b.name.trim().length > 0);
    return true;
  })();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-8 px-4 py-8 lg:grid-cols-[300px_1fr] lg:px-8">
        <aside className="lg:py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              {brand.logoText || "HOS"}
            </span>
            <div>
              <p className="text-sm font-semibold">Hospitality OS</p>
              <p className="text-xs text-muted-foreground">White-label setup</p>
            </div>
          </div>

          <div className="mt-8 hidden lg:block">
            <ol className="space-y-1">
              {steps.map((s, i) => {
                const done = i < step;
                const active = i === step;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => setStep(i)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                        active ? "bg-primary-soft" : "hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                          done && "border-success bg-success text-success-foreground",
                          active && "border-primary bg-primary text-primary-foreground",
                          !done && !active && "border-border text-muted-foreground",
                        )}
                      >
                        {done ? <Check className="size-3.5" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{s.title}</span>
                        <span className="block text-xs text-muted-foreground">{s.blurb}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="mt-6 rounded-xl border border-border bg-primary-soft/60 p-4 text-xs text-muted-foreground lg:mt-8">
            <Sparkles className="mb-2 size-4 text-primary" />
            Everything here is configurable later from System Administration.
          </div>
        </aside>

        <main className="flex min-w-0 flex-col">
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Step {step + 1} of {steps.length}
              </span>
              <span>{progress}% complete</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="surface-panel flex-1 p-6 md:p-8">
            <h1 className="font-display text-3xl">{current.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{current.blurb}</p>

            <div className="mt-8 space-y-6">
              {current.key === "business" ? (
                <>
                  <FieldGrid>
                    <div className="space-y-2">
                      <Label>Hotel / property name</Label>
                      <Input
                        value={organization.name}
                        onChange={(e) => setOrganization({ ...organization, name: e.target.value })}
                        placeholder="e.g. Mawimbi Jiko"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Legal business name</Label>
                      <Input
                        value={organization.legalName}
                        onChange={(e) =>
                          setOrganization({ ...organization, legalName: e.target.value })
                        }
                        placeholder="Registered company name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Business type</Label>
                      <Select
                        value={organization.businessType}
                        onValueChange={(v) =>
                          setOrganization({ ...organization, businessType: v as BusinessType })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(businessTypeLabels) as BusinessType[]).map((t) => (
                            <SelectItem key={t} value={t}>
                              {businessTypeLabels[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Logo initials (fallback mark)</Label>
                      <Input
                        maxLength={3}
                        value={brand.logoText}
                        onChange={(e) =>
                          setBrand({ ...brand, logoText: e.target.value.toUpperCase() })
                        }
                      />
                    </div>
                  </FieldGrid>
                  <div className="space-y-2">
                    <Label>Short property description</Label>
                    <Textarea
                      rows={4}
                      value={organization.description}
                      onChange={(e) =>
                        setOrganization({ ...organization, description: e.target.value })
                      }
                      placeholder="A short description guests and staff will see across documents and apps."
                    />
                  </div>
                </>
              ) : null}

              {current.key === "branding" ? (
                <>
                  <FieldGrid>
                    <ImageUploadField
                      label="Hotel logo"
                      hint="PNG or SVG with transparent background works best."
                      value={brand.logoLight}
                      onChange={(v) => setBrand({ ...brand, logoLight: v })}
                      aspect="wide"
                    />
                    <ImageUploadField
                      label="Favicon"
                      hint="Square icon shown in the browser tab."
                      value={brand.favicon}
                      onChange={(v) => setBrand({ ...brand, favicon: v })}
                    />
                  </FieldGrid>
                  <FieldGrid cols={3}>
                    <ColorField
                      label="Primary colour"
                      value={brand.primary}
                      onChange={(v) => setBrand({ ...brand, primary: v })}
                    />
                    <ColorField
                      label="Secondary colour"
                      value={brand.secondary}
                      onChange={(v) => setBrand({ ...brand, secondary: v })}
                    />
                    <ColorField
                      label="Accent colour"
                      value={brand.accent}
                      onChange={(v) => setBrand({ ...brand, accent: v })}
                    />
                  </FieldGrid>
                </>
              ) : null}

              {current.key === "contact" ? (
                <FieldGrid>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Physical address</Label>
                    <Textarea
                      rows={3}
                      value={contact.address}
                      onChange={(e) => setContact({ ...contact, address: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Primary phone</Label>
                    <Input
                      value={contact.phonePrimary}
                      onChange={(e) => setContact({ ...contact, phonePrimary: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Secondary phone</Label>
                    <Input
                      value={contact.phoneSecondary}
                      onChange={(e) => setContact({ ...contact, phoneSecondary: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Business email</Label>
                    <Input
                      type="email"
                      value={contact.email}
                      onChange={(e) => setContact({ ...contact, email: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Website</Label>
                    <Input
                      value={contact.website}
                      onChange={(e) => setContact({ ...contact, website: e.target.value })}
                      placeholder="https://"
                    />
                  </div>
                </FieldGrid>
              ) : null}

              {current.key === "regional" ? (
                <FieldGrid cols={3}>
                  <div className="space-y-2">
                    <Label>Country</Label>
                    <Select
                      value={regional.country}
                      onValueChange={(v) => {
                        const c = countries.find((x) => x.name === v);
                        setRegional({
                          ...regional,
                          country: v,
                          currency: c?.currency ?? regional.currency,
                          currencySymbol: c?.symbol ?? regional.currencySymbol,
                          timezone: c?.tz ?? regional.timezone,
                          taxLabel: c?.taxLabel ?? regional.taxLabel,
                          taxIdLabel: c?.taxId ?? regional.taxIdLabel,
                          vatRate: c?.rate ?? regional.vatRate,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {countries.map((c) => (
                          <SelectItem key={c.name} value={c.name}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Currency</Label>
                    <Input
                      value={regional.currency}
                      onChange={(e) => setRegional({ ...regional, currency: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Currency symbol</Label>
                    <Input
                      value={regional.currencySymbol}
                      onChange={(e) => setRegional({ ...regional, currencySymbol: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Time zone</Label>
                    <Input
                      value={regional.timezone}
                      onChange={(e) => setRegional({ ...regional, timezone: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Preferred language</Label>
                    <Select
                      value={regional.language}
                      onValueChange={(v) => setRegional({ ...regional, language: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="sw">Kiswahili</SelectItem>
                        <SelectItem value="fr">French</SelectItem>
                        <SelectItem value="ar">Arabic</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Date format</Label>
                    <Select
                      value={regional.dateFormat}
                      onValueChange={(v) => setRegional({ ...regional, dateFormat: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                        <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                        <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Time format</Label>
                    <Select
                      value={regional.timeFormat}
                      onValueChange={(v) =>
                        setRegional({ ...regional, timeFormat: v as "12h" | "24h" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24h">24-hour</SelectItem>
                        <SelectItem value="12h">12-hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Number formatting</Label>
                    <Select
                      value={regional.numberFormat}
                      onValueChange={(v) => setRegional({ ...regional, numberFormat: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1,234.56">1,234.56</SelectItem>
                        <SelectItem value="1.234,56">1.234,56</SelectItem>
                        <SelectItem value="1 234.56">1 234.56</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </FieldGrid>
              ) : null}

              {current.key === "tax" ? (
                <FieldGrid>
                  <div className="space-y-2">
                    <Label>Tax label</Label>
                    <Input
                      value={regional.taxLabel}
                      onChange={(e) => setRegional({ ...regional, taxLabel: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{regional.taxLabel} rate (%)</Label>
                    <Input
                      type="number"
                      value={regional.vatRate}
                      onChange={(e) =>
                        setRegional({ ...regional, vatRate: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Tax identifier label</Label>
                    <Input
                      value={regional.taxIdLabel}
                      onChange={(e) => setRegional({ ...regional, taxIdLabel: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{regional.taxIdLabel}</Label>
                    <Input
                      value={regional.taxId}
                      onChange={(e) => setRegional({ ...regional, taxId: e.target.value })}
                      placeholder="e.g. P051234567X"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Business registration number</Label>
                    <Input
                      value={regional.registrationNumber}
                      onChange={(e) =>
                        setRegional({ ...regional, registrationNumber: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
                    <div>
                      <p className="text-sm font-medium">Prices include tax</p>
                      <p className="text-xs text-muted-foreground">
                        Applies to menus, rates and documents
                      </p>
                    </div>
                    <Switch
                      checked={regional.pricesIncludeTax}
                      onCheckedChange={(v) => setRegional({ ...regional, pricesIncludeTax: v })}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Business registration details</Label>
                    <Textarea
                      rows={3}
                      value={regional.registrationDetails}
                      onChange={(e) =>
                        setRegional({ ...regional, registrationDetails: e.target.value })
                      }
                      placeholder="Registrar, date of incorporation, licences…"
                    />
                  </div>
                </FieldGrid>
              ) : null}

              {current.key === "branches" ? (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
                    <div>
                      <p className="text-sm font-medium">We operate multiple branches</p>
                      <p className="text-xs text-muted-foreground">
                        Add every property you want to manage from this workspace
                      </p>
                    </div>
                    <Switch checked={multiBranch} onCheckedChange={setMultiBranch} />
                  </div>

                  {branches.map((branch, index) => (
                    <div key={branch.id} className="rounded-xl border border-border p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-sm font-semibold">
                          {branch.isMain ? "Main branch" : `Branch ${index + 1}`}
                        </p>
                        {!branch.isMain ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setBranches((prev) => prev.filter((b) => b.id !== branch.id))
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                      <FieldGrid>
                        <div className="space-y-2">
                          <Label>Branch name</Label>
                          <Input
                            value={branch.name}
                            onChange={(e) => patchBranch(branch.id, { name: e.target.value })}
                            placeholder="e.g. Mawimbi Jiko – Taveta"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Branch phone</Label>
                          <Input
                            value={branch.phone}
                            onChange={(e) => patchBranch(branch.id, { phone: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Branch email</Label>
                          <Input
                            value={branch.email}
                            onChange={(e) => patchBranch(branch.id, { email: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Branch address</Label>
                          <Input
                            value={branch.address}
                            onChange={(e) => patchBranch(branch.id, { address: e.target.value })}
                          />
                        </div>
                      </FieldGrid>
                    </div>
                  ))}

                  {multiBranch ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setBranches((prev) => [...prev, makeBranch({ name: "", isMain: false })])
                      }
                    >
                      <Plus className="size-4" />
                      Add another branch
                    </Button>
                  ) : null}
                </>
              ) : null}

              {current.key === "review" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <ReviewBlock
                    title="Business"
                    rows={[
                      ["Property", organization.name || "—"],
                      ["Legal name", organization.legalName || "—"],
                      ["Type", businessTypeLabels[organization.businessType]],
                    ]}
                  />
                  <ReviewBlock
                    title="Contact"
                    rows={[
                      ["Email", contact.email || "—"],
                      ["Phone", contact.phonePrimary || "—"],
                      ["Website", contact.website || "—"],
                    ]}
                  />
                  <ReviewBlock
                    title="Regional"
                    rows={[
                      ["Country", regional.country],
                      ["Currency", `${regional.currency} (${regional.currencySymbol})`],
                      ["Time zone", regional.timezone],
                      ["Formats", `${regional.dateFormat} · ${regional.timeFormat}`],
                    ]}
                  />
                  <ReviewBlock
                    title="Tax & legal"
                    rows={[
                      [regional.taxIdLabel, regional.taxId || "—"],
                      [`${regional.taxLabel} rate`, `${regional.vatRate}%`],
                      ["Registration", regional.registrationNumber || "—"],
                    ]}
                  />
                  <ReviewBlock
                    title="Branding"
                    rows={[
                      ["Logo", brand.logoLight ? "Uploaded" : "Not uploaded"],
                      ["Favicon", brand.favicon ? "Uploaded" : "Not uploaded"],
                      ["Colours", `${brand.primary} · ${brand.accent}`],
                    ]}
                  />
                  <ReviewBlock
                    title="Branches"
                    rows={branches
                      .filter((b) => b.name)
                      .map((b) => [b.isMain ? "Main" : "Branch", b.name] as [string, string])}
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6">
              <Button
                type="button"
                variant="ghost"
                disabled={step === 0}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              {step === steps.length - 1 ? (
                <Button type="button" onClick={finish}>
                  Complete Setup
                  <Check className="size-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={!canContinue}
                  onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}
                >
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ReviewBlock({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-sm font-semibold">{title}</p>
      <dl className="mt-3 space-y-2">
        {rows.length ? (
          rows.map(([k, v]) => (
            <div key={k + v} className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-medium">{v}</dd>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Nothing added yet</p>
        )}
      </dl>
    </div>
  );
}
