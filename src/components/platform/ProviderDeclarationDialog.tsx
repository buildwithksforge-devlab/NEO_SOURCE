/**
 * Provider registry — declaration form.
 *
 * A provider describes itself here before anybody can connect to it: what kind
 * of provider it is, what it can actually do, and what a property must supply
 * before a connection is possible. Nothing is invented on the provider's
 * behalf — an empty declaration is refused by the database.
 */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ProviderDeclaration, ProviderRequirement } from "@/lib/platform-data";

export const PROVIDER_CATEGORIES = [
  "payments",
  "channel_manager",
  "accounting",
  "messaging",
  "identity",
  "hardware",
  "analytics",
  "other",
];

const REQUIREMENT_KINDS: ProviderRequirement["kind"][] = ["secret", "setting", "evidence"];

type Props = {
  open: boolean;
  existing?: Record<string, any> | null;
  pending?: boolean;
  onClose: () => void;
  onSubmit: (declaration: ProviderDeclaration) => void;
};

const emptyRequirement = (): ProviderRequirement => ({
  key: "",
  label: "",
  kind: "setting",
  required: true,
  help: "",
});

export function ProviderDeclarationDialog({ open, existing, pending, onClose, onSubmit }: Props) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("payments");
  const [purpose, setPurpose] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [secretNames, setSecretNames] = useState("");
  const [documentationUrl, setDocumentationUrl] = useState("");
  const [supportContact, setSupportContact] = useState("");
  const [webhooks, setWebhooks] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [partnerApproval, setPartnerApproval] = useState(false);
  const [requirements, setRequirements] = useState<ProviderRequirement[]>([emptyRequirement()]);

  useEffect(() => {
    if (!open) return;
    setCode(String(existing?.["code"] ?? ""));
    setName(String(existing?.["name"] ?? ""));
    setCategory(String(existing?.["category"] ?? "payments"));
    setPurpose(String(existing?.["purpose"] ?? ""));
    setCapabilities(((existing?.["capabilities"] as string[]) ?? []).join(", "));
    setSecretNames(((existing?.["required_secret_names"] as string[]) ?? []).join(", "));
    setDocumentationUrl(String(existing?.["documentation_url"] ?? ""));
    setSupportContact(String(existing?.["support_contact"] ?? ""));
    setWebhooks(Boolean(existing?.["supports_webhooks"]));
    setSandbox(Boolean(existing?.["supports_sandbox"]));
    setPartnerApproval(Boolean(existing?.["requires_partner_approval"]));
    const reqs = (existing?.["connection_requirements"] as ProviderRequirement[]) ?? [];
    setRequirements(reqs.length > 0 ? reqs : [emptyRequirement()]);
  }, [open, existing]);

  const list = (value: string) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

  const cleanRequirements = requirements.filter((r) => r.key.trim() && r.label.trim());
  const ready =
    code.trim().length > 0 &&
    name.trim().length > 0 &&
    list(capabilities).length > 0 &&
    cleanRequirements.length > 0;

  const update = (index: number, patch: Partial<ProviderRequirement>) =>
    setRequirements((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : null)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Update provider declaration" : "Declare a provider"}</DialogTitle>
          <DialogDescription>
            What the provider is, what it can do and what it needs. A property cannot start a
            connection until this is complete.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="provider-code">Code</Label>
              <Input
                id="provider-code"
                value={code}
                disabled={Boolean(existing)}
                onChange={(e) => setCode(e.target.value)}
                placeholder="acme_pay"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-name">Name</Label>
              <Input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-purpose">What it is used for</Label>
            <Textarea
              id="provider-purpose"
              rows={2}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-caps">Capabilities (comma separated)</Label>
            <Input
              id="provider-caps"
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="collect_payment, refund, payment_status, settlement_report"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-secrets">Server-side secret names (comma separated)</Label>
            <Input
              id="provider-secrets"
              value={secretNames}
              onChange={(e) => setSecretNames(e.target.value)}
              placeholder="ACME_PAY_API_KEY"
              className="font-mono text-xs"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="provider-docs">Documentation address</Label>
              <Input
                id="provider-docs"
                value={documentationUrl}
                onChange={(e) => setDocumentationUrl(e.target.value)}
                placeholder="https://"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-support">Support contact</Label>
              <Input
                id="provider-support"
                value={supportContact}
                onChange={(e) => setSupportContact(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <ToggleRow label="Supports webhooks" checked={webhooks} onChange={setWebhooks} />
            <ToggleRow label="Has a sandbox" checked={sandbox} onChange={setSandbox} />
            <ToggleRow
              label="Partner approval required"
              checked={partnerApproval}
              onChange={setPartnerApproval}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Connection requirements</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRequirements((r) => [...r, emptyRequirement()])}
              >
                <Plus className="mr-1 size-3.5" /> Add
              </Button>
            </div>
            {requirements.map((r, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
                <Input
                  value={r.key}
                  onChange={(e) => update(index, { key: e.target.value })}
                  placeholder="merchant_id"
                  className="font-mono text-xs"
                />
                <Input
                  value={r.label}
                  onChange={(e) => update(index, { label: e.target.value })}
                  placeholder="Merchant identifier"
                />
                <Select
                  value={r.kind}
                  onValueChange={(v) => update(index, { kind: v as ProviderRequirement["kind"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIREMENT_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setRequirements((rows) => rows.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              A secret is held server-side and never entered here; a setting is configuration such
              as a merchant identifier; evidence is something a property must prove, such as a
              signed agreement.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!ready || pending}
              onClick={() =>
                onSubmit({
                  code: code.trim(),
                  name: name.trim(),
                  category,
                  purpose: purpose.trim() || null,
                  capabilities: list(capabilities),
                  requirements: cleanRequirements.map((r) => ({
                    key: r.key.trim(),
                    label: r.label.trim(),
                    kind: r.kind,
                    required: r.required ?? true,
                    help: r.help?.trim() || null,
                  })),
                  requiredSecretNames: list(secretNames),
                  documentationUrl: documentationUrl.trim() || null,
                  supportContact: supportContact.trim() || null,
                  supportsWebhooks: webhooks,
                  supportsSandbox: sandbox,
                  requiresPartnerApproval: partnerApproval,
                })
              }
            >
              Record declaration
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <span className="text-xs text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
