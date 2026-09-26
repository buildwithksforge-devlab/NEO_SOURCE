import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  Rocket,
  Save,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenant } from "@/lib/tenant";
import type { AppKey } from "@/lib/tenant-types";
import { publicAppLabels, slugify } from "@/lib/public-apps";
import {
  publicUrlFor,
  useBranchOptions,
  useDeliveryReadinessFacts,
  useOrganization,
  usePublicWorkspaces,
  usePublishWorkspace,
  useSaveWorkspaceDraft,
  useUnpublishWorkspace,
  type DraftInput,
  type WorkspaceRecord,
} from "@/lib/public-apps-data";
import { cn } from "@/lib/utils";

type Check = { label: string; ok: boolean; hint: string };

function statusTone(status: string) {
  if (status === "published") return "bg-emerald-100 text-emerald-800";
  if (status === "unpublished") return "bg-amber-100 text-amber-900";
  return "bg-muted text-muted-foreground";
}

function formatStamp(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** Publishing controls for one public application tab. */
export function AppPublishPanel({ appKey }: { appKey: AppKey }) {
  const { tenant } = useTenant();
  const branding = tenant.appBranding[appKey];
  const org = useOrganization();
  const branches = useBranchOptions();
  const workspaces = usePublicWorkspaces();
  const saveDraft = useSaveWorkspaceDraft();
  const publish = usePublishWorkspace();
  const unpublish = useUnpublishWorkspace();

  const record = useMemo<WorkspaceRecord | undefined>(
    () => workspaces.data?.find((w) => w.app_key === appKey),
    [workspaces.data, appKey],
  );

  const [branchId, setBranchId] = useState<string>("");
  const [slug, setSlug] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [opens, setOpens] = useState("07:00");
  const [closes, setCloses] = useState("22:00");
  const [showPreview, setShowPreview] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  // Seed the form from the stored record, otherwise from tenant configuration.
  useEffect(() => {
    if (!workspaces.isSuccess) return;
    const hours = (record?.settings as { operating_hours?: { opens?: string; closes?: string } })
      ?.operating_hours;
    setBranchId(record?.branch_id ?? branches.data?.find((b) => b.is_main)?.id ?? "");
    setSlug(record?.slug ?? slugify(tenant.organization.name || "workspace"));
    setPhone(record?.contact_phone ?? tenant.contact.phonePrimary ?? "");
    setEmail(record?.contact_email ?? tenant.contact.email ?? "");
    setAddress(record?.contact_address ?? tenant.contact.address ?? "");
    setOpens(hours?.opens ?? "07:00");
    setCloses(hours?.closes ?? "22:00");
  }, [workspaces.isSuccess, record, branches.data, tenant, appKey]);

  const facts = useDeliveryReadinessFacts(appKey === "delivery" ? branchId || null : null);

  const draft: DraftInput = {
    appKey,
    branchId: branchId || null,
    slug,
    appName: branding.appName,
    hotelName: tenant.organization.name,
    contactPhone: phone,
    contactEmail: email,
    contactAddress: address,
    openingTime: opens,
    closingTime: closes,
    primaryColor: branding.primary,
    secondaryColor: branding.secondary,
    backgroundColor: tenant.brand.background || "#F7F9FC",
    welcomeTitle: branding.welcomeTitle,
    welcomeMessage: branding.welcomeMessage,
    logoUrl: branding.logo,
    iconUrl: branding.icon,
    menuStyle: branding.menuStyle,
  };

  const settings = facts.data?.settings ?? null;
  const paymentMethods = settings?.allowed_payment_methods ?? [];
  const deliveryEnabled = Boolean(settings?.delivery_enabled);

  const checks: Check[] = [
    {
      label: "Organisation",
      ok: Boolean(org.data?.id && tenant.organization.name),
      hint: "Set the hotel name in Administration → Hotel Information.",
    },
    {
      label: "Property / branch",
      ok: Boolean(branchId),
      hint: "Choose the property this app serves.",
    },
    {
      label: "App name",
      ok: Boolean(branding.appName.trim()),
      hint: "Add an app name in the Identity section above.",
    },
    {
      label: "Contact details",
      ok: Boolean(phone.trim() && email.trim()),
      hint: "A public phone number and email are required.",
    },
    {
      label: "Operating hours",
      ok: Boolean(opens && closes && opens !== closes),
      hint: "Set opening and closing times.",
    },
    {
      label: "Customer-facing branding",
      ok: Boolean(
        branding.primary && branding.welcomeTitle.trim() && branding.welcomeMessage.trim(),
      ),
      hint: "Complete theme colour, welcome title and welcome message.",
    },
  ];

  if (appKey === "delivery") {
    checks.push(
      {
        label: "Active menu",
        ok: (facts.data?.activeMenus ?? 0) > 0,
        hint: "Publish at least one active menu for this property in Restaurant → Menu.",
      },
      {
        label: "Fulfilment method",
        ok: Boolean(settings?.delivery_enabled || settings?.pickup_enabled),
        hint: "Enable delivery and/or pickup in Delivery settings.",
      },
      {
        label: "Delivery zones",
        ok: !deliveryEnabled || (facts.data?.activeZones ?? 0) > 0,
        hint: "Add at least one active delivery zone while delivery is enabled.",
      },
      {
        label: "Payment method",
        ok: paymentMethods.length > 0 || Boolean(settings?.cod_enabled),
        hint: "Allow at least one payment method in Delivery settings.",
      },
    );
  }

  const blocking = checks.filter((c) => !c.ok);
  const ready = blocking.length === 0;
  const status = record?.status ?? "draft";
  const isPublished = status === "published" && record?.published;
  const publicUrl = isPublished && record ? publicUrlFor(appKey, record.slug) : null;

  async function downloadQr() {
    if (!publicUrl) return;
    const QR = await import("qrcode");
    const dataUrl = await QR.toDataURL(publicUrl, { width: 720, margin: 2 });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${appKey}-app-qr.png`;
    a.click();
  }

  useEffect(() => {
    let cancelled = false;
    if (!publicUrl) {
      setQr(null);
      return;
    }
    void import("qrcode").then(async (QR) => {
      const url = await QR.toDataURL(publicUrl, { width: 240, margin: 1 });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [publicUrl]);

  const busy = saveDraft.isPending || publish.isPending || unpublish.isPending;

  return (
    <SectionCard
      title={`Publishing — ${publicAppLabels[appKey]}`}
      description="Control whether this customer-facing application is live and share its public address."
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold capitalize",
            statusTone(status),
          )}
        >
          {status}
        </span>
        <span className="text-xs text-muted-foreground">
          Last published: {formatStamp(record?.published_at ?? null)}
        </span>
        <span className="text-xs text-muted-foreground">
          Published by: {record?.published_by_name ?? "—"}
        </span>
        {record?.unpublished_at && status === "unpublished" ? (
          <span className="text-xs text-muted-foreground">
            Taken offline: {formatStamp(record.unpublished_at)}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Property / branch</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a property" />
            </SelectTrigger>
            <SelectContent>
              {(branches.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                  {b.is_main ? " (main)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Public address slug</Label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="hotel-name"
            disabled={appKey === "rider"}
          />
          <p className="text-xs text-muted-foreground">
            {appKey === "rider"
              ? "The Rider App is always served at /rider."
              : `Public route: /${appKey}/${slugify(slug || "hotel-name")}`}
          </p>
        </div>
        <div className="space-y-2">
          <Label>Public phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Public email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>Public address</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Opens</Label>
          <Input type="time" value={opens} onChange={(e) => setOpens(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Closes</Label>
          <Input type="time" value={closes} onChange={(e) => setCloses(e.target.value)} />
        </div>
      </div>

      <div className="rounded-xl border border-border p-4">
        <p className="text-sm font-medium">Pre-publication checklist</p>
        <ul className="mt-3 space-y-2">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-sm">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 size-4 text-destructive" />
              )}
              <span>
                <span className={c.ok ? "" : "font-medium"}>{c.label}</span>
                {c.ok ? null : (
                  <span className="block text-xs text-muted-foreground">{c.hint}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {facts.isLoading && appKey === "delivery" ? (
          <p className="mt-3 text-xs text-muted-foreground">Checking delivery readiness…</p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            saveDraft.mutate(draft, {
              onSuccess: () => toast.success("Draft saved"),
              onError: (e) => toast.error((e as Error).message),
            })
          }
        >
          {saveDraft.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save Draft
        </Button>
        <Button variant="outline" onClick={() => setShowPreview(true)}>
          <Eye className="size-4" />
          Preview Draft
        </Button>
        <Button
          disabled={busy || !ready}
          onClick={() =>
            publish.mutate(draft, {
              onSuccess: () => toast.success(`${publicAppLabels[appKey]} published`),
              onError: (e) => toast.error((e as Error).message),
            })
          }
        >
          {publish.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Rocket className="size-4" />
          )}
          Publish App
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !isPublished}
          onClick={() =>
            record &&
            unpublish.mutate(record.id, {
              onSuccess: () => toast.success("App taken offline"),
              onError: (e) => toast.error((e as Error).message),
            })
          }
        >
          Unpublish
        </Button>
      </div>

      {!ready ? (
        <p className="text-xs text-muted-foreground">
          Publishing is blocked until {blocking.length} item
          {blocking.length === 1 ? " is" : "s are"} completed above.
        </p>
      ) : null}

      {publicUrl ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm font-medium">Public URL</p>
          <p className="mt-1 break-all text-sm text-primary">{publicUrl}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={publicUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                Open App
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(publicUrl);
                toast.success("Link copied");
              }}
            >
              <Copy className="size-3.5" />
              Copy Link
            </Button>
            <Button variant="outline" size="sm" onClick={() => void downloadQr()}>
              <Download className="size-3.5" />
              Download QR Code
            </Button>
            {qr ? <img src={qr} alt="Public app QR code" className="size-16 rounded-md" /> : null}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          The public URL appears here once the app has been published.
        </p>
      )}

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Draft preview — {publicAppLabels[appKey]}</DialogTitle>
          </DialogHeader>
          <div
            className="mx-auto flex aspect-[9/16] w-full max-w-[240px] flex-col items-center justify-center gap-3 rounded-[2rem] border-4 border-foreground/10 p-5 text-center"
            style={{ background: branding.primary }}
          >
            {branding.splash || branding.logo ? (
              <img
                src={(branding.splash || branding.logo)!}
                alt=""
                className="max-h-24 w-full object-contain"
              />
            ) : null}
            <p className="text-sm font-semibold text-white">{branding.appName}</p>
            <p className="text-xs text-white/80">{branding.welcomeTitle}</p>
            <p className="text-[0.65rem] text-white/70">{branding.welcomeMessage}</p>
            <p className="text-[0.65rem] text-white/60">
              {tenant.organization.name} · {opens}–{closes}
            </p>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Draft preview only — customers cannot reach the app until it is published.
          </p>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
