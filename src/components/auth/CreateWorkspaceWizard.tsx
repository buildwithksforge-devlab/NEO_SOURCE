import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { buildWorkspaceOwnerMetadata } from "@/lib/auth-email-metadata";
import {
  awaitAuthenticatedUser,
  provisionWorkspace,
  STAGE_TEXT,
  type ProvisionStage,
} from "@/lib/workspace-provisioning";

export const PENDING_WORKSPACE_KEY = "neo.pendingWorkspace";

export type WorkspacePayload = {
  admin_full_name: string;
  admin_phone: string;
  business_name: string;
  legal_name: string;
  trading_name: string;
  business_type: string;
  country: string;
  currency: string;
  timezone: string;
  business_phone: string;
  business_email: string;
  property_count: string;
  property_name: string;
  property_code: string;
  property_address: string;
  property_city: string;
  property_country: string;
  property_phone: string;
  property_email: string;
  language: string;
  business_role: string;
  /** Catalogue key of the administrative role granted to the creator. */
  admin_role_key: string;
};

const steps = ["Your Account", "Business", "First Property", "Review"] as const;

const businessTypes = [
  "Hotel",
  "Restaurant",
  "Lodge",
  "Resort",
  "Serviced Apartments",
  "Hospitality Group",
  "Other Hospitality Business",
];

/**
 * The administrative role the creator is granted. Nothing here implies
 * ownership: the Owner role is created for the organisation but is only
 * granted when it is deliberately selected here.
 */
const businessRoles: { label: string; key: string }[] = [
  { label: "Owner / Director", key: "owner" },
];


const countries = [
  { name: "Kenya", currency: "KES", tz: "Africa/Nairobi" },
  { name: "Tanzania", currency: "TZS", tz: "Africa/Dar_es_Salaam" },
  { name: "Uganda", currency: "UGX", tz: "Africa/Kampala" },
  { name: "Rwanda", currency: "RWF", tz: "Africa/Kigali" },
  { name: "South Africa", currency: "ZAR", tz: "Africa/Johannesburg" },
  { name: "Nigeria", currency: "NGN", tz: "Africa/Lagos" },
  { name: "United Kingdom", currency: "GBP", tz: "Europe/London" },
  { name: "United Arab Emirates", currency: "AED", tz: "Asia/Dubai" },
  { name: "United States", currency: "USD", tz: "America/New_York" },
];

const checklist = [
  "Complete hotel profile",
  "Create departments",
  "Configure roles",
  "Add employee records",
  "Invite users",
  "Configure rooms and services",
  "Configure applications",
  "Review security settings",
];

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-neo-midnight">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-neo-steel">{hint}</p> : null}
    </div>
  );
}

const inputClass =
  "h-11 rounded-xl border-neo-mist bg-white text-neo-midnight focus-visible:border-neo-turquoise focus-visible:ring-neo-turquoise/40";

export function CreateWorkspaceWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"created" | "verify" | null>(null);
  const [stage, setStage] = useState<ProvisionStage>("idle");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [terms, setTerms] = useState(false);
  const [form, setForm] = useState<WorkspacePayload>({
    admin_full_name: "",
    admin_phone: "",
    business_name: "",
    legal_name: "",
    trading_name: "",
    business_type: "Hotel",
    country: "Kenya",
    currency: "KES",
    timezone: "Africa/Nairobi",
    business_phone: "",
    business_email: "",
    property_count: "1",
    property_name: "",
    property_code: "MAIN",
    property_address: "",
    property_city: "",
    property_country: "Kenya",
    property_phone: "",
    property_email: "",
    language: "English",
    business_role: "Owner / Director",
    admin_role_key: "owner",
  });

  const set = <K extends keyof WorkspacePayload>(key: K, value: WorkspacePayload[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function validateStep(): string | null {
    if (step === 0) {
      if (!form.admin_full_name.trim()) return "Enter your full name.";
      if (!/^\S+@\S+\.\S+$/.test(email)) return "Enter a valid email address.";
      if (password.length < 8) return "Use at least 8 characters for your password.";
      if (password !== confirm) return "Passwords do not match.";
      if (!terms) return "Accept the terms and privacy policy to continue.";
    }
    if (step === 1) {
      if (!form.business_name.trim()) return "Enter your legal or business name.";
    }
    if (step === 2) {
      if (!form.property_name.trim()) return "Enter your first property name.";
      if (!form.property_code.trim()) return "Enter a property code.";
    }
    return null;
  }

  function next() {
    const problem = validateStep();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }

  async function submit() {
    if (busy) return; // double-click and retry cannot create duplicates
    setError(null);
    setBusy(true);
    const correlationId = crypto.randomUUID().slice(0, 8).toUpperCase();
    try {
      const payload: WorkspacePayload = {
        ...form,
        legal_name: form.legal_name || form.business_name,
        trading_name: form.trading_name || form.business_name,
        business_email: form.business_email || email,
        admin_role_key:
          businessRoles.find((r) => r.label === form.business_role)?.key ?? "owner",
      };
      // The payload is kept locally first: the provisioning attempt is a
      // privileged, authenticated-only record, so it can only be written once
      // the account exists and a verified session is present. Anonymous
      // callers never reach the provisioning helpers.
      const idempotencyKey = `${email.trim().toLowerCase()}::${payload.business_name.trim().toLowerCase()}`;
      window.localStorage.setItem(PENDING_WORKSPACE_KEY, JSON.stringify(payload));

      setStage("creating-account");
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth`,
          data: {
            ...buildWorkspaceOwnerMetadata({
              full_name: payload.admin_full_name,
              organisation_name: payload.business_name,
              role_title: form.business_role || null,
            }),
            org_name: payload.business_name,
            // The draft travels with the creator's own account so the
            // workspace can still be finished when the confirmation e-mail is
            // opened on another device or browser. It carries no identifiers
            // and only ever provisions a workspace for this same account.
            workspace_draft: payload,
          },
        },
      });
      if (signUpError) throw new Error(signUpError.message);

      if (data.session) {
        // Confirm the client actually applied the session and that the server
        // recognises the user before any privileged RPC is attempted.
        setStage("establishing-session");
        const userId = await awaitAuthenticatedUser();
        if (!userId) {
          setStage("verify-email");
          setDone("verify");
          return;
        }
        await provisionWorkspace(payload as unknown as Record<string, unknown>, idempotencyKey, setStage);
        window.localStorage.removeItem(PENDING_WORKSPACE_KEY);
        setStage("ready");
        setDone("created");
        toast.success("Your NEØ workspace is ready");
      } else {
        // Email confirmation required. The saved draft is submitted on the
        // creator's first verified sign-in — never before.
        setStage("verify-email");
        setDone("verify");
      }

    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      const friendly = /permission denied|violates|syntax|relation |function /i.test(raw)
        ? "We could not complete your workspace right now. Your details have been kept — please try again."
        : raw || "Unable to create your workspace.";
      setError(`${friendly} (Reference ${correlationId})`);
    } finally {
      setBusy(false);
      setStage((s) => (s === "ready" ? s : "idle"));
    }
  }

  if (done === "verify") {
    return (
      <div className="rounded-2xl border border-neo-mist bg-white p-6">
        <h2 className="font-display text-xl text-neo-midnight">Verify your email</h2>
        <p className="mt-2 text-sm text-neo-steel">
          We sent a verification link to <span className="font-medium">{email}</span>. Confirm your
          address, then sign in — your workspace is created securely on first sign-in.
        </p>
      </div>
    );
  }

  if (done === "created") {
    return (
      <div className="rounded-2xl border border-neo-mist bg-white p-6">
        <h2 className="font-display text-2xl text-neo-midnight">Your NEØ workspace is ready.</h2>
        <ol className="mt-5 space-y-2 text-sm text-neo-steel">
          {checklist.map((item, i) => (
            <li key={item} className="flex items-center gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-neo-mist text-xs font-semibold text-neo-midnight">
                {i + 1}
              </span>
              {item}
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            className="h-11 rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white"
            onClick={() => navigate({ to: "/workspace", replace: true })}
          >
            Enter Workspace
          </Button>
          <Button
            variant="outline"
            className="h-11 rounded-xl border-neo-mist"
            onClick={() => navigate({ to: "/users" })}
          >
            Add Employees
          </Button>
          <Button
            variant="outline"
            className="h-11 rounded-xl border-neo-mist"
            onClick={() => navigate({ to: "/users" })}
          >
            Invite Users
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ol className="flex items-center gap-2" aria-label="Workspace setup progress">
        {steps.map((label, i) => (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className={cn(
                "h-1 rounded-full",
                i <= step ? "bg-neo-turquoise" : "bg-neo-mist",
              )}
            />
            <span
              className={cn(
                "truncate text-[0.68rem] font-medium",
                i === step ? "text-neo-midnight" : "text-neo-steel",
              )}
            >
              {i + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-6 space-y-4">
        {step === 0 ? (
          <>
            <Field id="ws-name" label="Full name">
              <Input
                id="ws-name"
                className={inputClass}
                value={form.admin_full_name}
                onChange={(e) => set("admin_full_name", e.target.value)}
                autoComplete="name"
              />
            </Field>
            <Field
              id="ws-email"
              label="Email address"
              hint="Company-domain, Gmail, Yahoo or Outlook addresses are all accepted."
            >
              <Input
                id="ws-email"
                type="email"
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </Field>
            <Field id="ws-phone" label="Phone number">
              <Input
                id="ws-phone"
                className={inputClass}
                value={form.admin_phone}
                onChange={(e) => set("admin_phone", e.target.value)}
                autoComplete="tel"
                inputMode="tel"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ws-pass" label="Password" hint="Minimum 8 characters.">
                <Input
                  id="ws-pass"
                  type="password"
                  className={inputClass}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field id="ws-pass2" label="Confirm password">
                <Input
                  id="ws-pass2"
                  type="password"
                  className={inputClass}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <label className="flex items-start gap-3 text-sm text-neo-steel">
              <Checkbox
                checked={terms}
                onCheckedChange={(v) => setTerms(Boolean(v))}
                aria-label="Accept terms and privacy policy"
              />
              I accept the NEØ terms of service and privacy policy.
            </label>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Field id="ws-legal" label="Legal / business name">
              <Input
                id="ws-legal"
                className={inputClass}
                value={form.business_name}
                onChange={(e) => set("business_name", e.target.value)}
              />
            </Field>
            <Field id="ws-trading" label="Trading name">
              <Input
                id="ws-trading"
                className={inputClass}
                value={form.trading_name}
                onChange={(e) => set("trading_name", e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ws-type" label="Business type">
                <Select
                  value={form.business_type}
                  onValueChange={(v) => set("business_type", v)}
                >
                  <SelectTrigger id="ws-type" className={inputClass}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {businessTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="ws-country" label="Country">
                <Select
                  value={form.country}
                  onValueChange={(v) => {
                    const c = countries.find((x) => x.name === v);
                    setForm((f) => ({
                      ...f,
                      country: v,
                      property_country: v,
                      currency: c?.currency ?? f.currency,
                      timezone: c?.tz ?? f.timezone,
                    }));
                  }}
                >
                  <SelectTrigger id="ws-country" className={inputClass}>
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
              </Field>
              <Field id="ws-currency" label="Currency">
                <Input
                  id="ws-currency"
                  className={inputClass}
                  value={form.currency}
                  onChange={(e) => set("currency", e.target.value.toUpperCase())}
                />
              </Field>
              <Field id="ws-tz" label="Time zone">
                <Input
                  id="ws-tz"
                  className={inputClass}
                  value={form.timezone}
                  onChange={(e) => set("timezone", e.target.value)}
                />
              </Field>
              <Field id="ws-bphone" label="Main phone">
                <Input
                  id="ws-bphone"
                  className={inputClass}
                  value={form.business_phone}
                  onChange={(e) => set("business_phone", e.target.value)}
                  inputMode="tel"
                />
              </Field>
              <Field id="ws-bemail" label="Official email">
                <Input
                  id="ws-bemail"
                  type="email"
                  className={inputClass}
                  value={form.business_email}
                  onChange={(e) => set("business_email", e.target.value)}
                />
              </Field>
              <Field id="ws-count" label="Number of properties">
                <Input
                  id="ws-count"
                  type="number"
                  min={1}
                  className={inputClass}
                  value={form.property_count}
                  onChange={(e) => set("property_count", e.target.value)}
                />
              </Field>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ws-pname" label="Property / branch name">
              <Input
                id="ws-pname"
                className={inputClass}
                value={form.property_name}
                onChange={(e) => set("property_name", e.target.value)}
              />
            </Field>
            <Field id="ws-pcode" label="Property code">
              <Input
                id="ws-pcode"
                className={inputClass}
                value={form.property_code}
                onChange={(e) => set("property_code", e.target.value.toUpperCase())}
              />
            </Field>
            <Field id="ws-paddr" label="Physical address">
              <Input
                id="ws-paddr"
                className={inputClass}
                value={form.property_address}
                onChange={(e) => set("property_address", e.target.value)}
              />
            </Field>
            <Field id="ws-pcity" label="Town / city">
              <Input
                id="ws-pcity"
                className={inputClass}
                value={form.property_city}
                onChange={(e) => set("property_city", e.target.value)}
              />
            </Field>
            <Field id="ws-pphone" label="Phone">
              <Input
                id="ws-pphone"
                className={inputClass}
                value={form.property_phone}
                onChange={(e) => set("property_phone", e.target.value)}
                inputMode="tel"
              />
            </Field>
            <Field id="ws-pemail" label="Email">
              <Input
                id="ws-pemail"
                type="email"
                className={inputClass}
                value={form.property_email}
                onChange={(e) => set("property_email", e.target.value)}
              />
            </Field>
            <Field id="ws-lang" label="Preferred language">
              <Input
                id="ws-lang"
                className={inputClass}
                value={form.language}
                onChange={(e) => set("language", e.target.value)}
              />
            </Field>
            <Field
              id="ws-role"
              label="Your business role"
              hint="Technical administration and business authority stay distinguishable."
            >
              <Select value={form.business_role} onValueChange={(v) => set("business_role", v)}>
                <SelectTrigger id="ws-role" className={inputClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {businessRoles.map((r) => (
                    <SelectItem key={r.key} value={r.label}>
                      {r.label}
                    </SelectItem>
                  ))}

                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="rounded-2xl border border-neo-mist bg-white p-5">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                ["Administrator", form.admin_full_name],
                ["Administrator email", email],
                ["Business", form.business_name],
                ["Property", form.property_name],
                ["Business role", form.business_role],
                ["Currency", form.currency],
                ["Time zone", form.timezone],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs uppercase tracking-wide text-neo-steel">{k}</dt>
                  <dd className="mt-0.5 font-medium text-neo-midnight">{v || "—"}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-neo-steel">
              You will receive administration of this organisation only. NEØ platform
              administration and other organisations remain out of reach.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="ghost"
            className="h-11 rounded-xl text-neo-steel"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy}
          >
            <ArrowLeft className="size-4" /> Back
          </Button>
          {step < steps.length - 1 ? (
            <Button
              type="button"
              onClick={next}
              className="h-11 rounded-xl bg-neo-turquoise px-6 font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white"
            >
              Continue <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="h-11 rounded-xl bg-neo-turquoise px-6 font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-neo-white"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Create Workspace
            </Button>
          )}
        </div>
        {busy && stage !== "idle" ? (
          <p className="pt-2 text-sm text-neo-steel" role="status">
            {STAGE_TEXT[stage]}
          </p>
        ) : null}

      </div>
    </div>
  );
}
