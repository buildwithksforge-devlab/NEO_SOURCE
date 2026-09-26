/**
 * HR settings editor.
 *
 * The HR Settings screen advertises attendance tolerance, leave year, document
 * retention and payroll integration, so this form actually exposes those
 * controls rather than describing them. Nothing here is a business fact the
 * system may invent: the initialise action writes the organisation's row with
 * the database's own documented defaults, and every value afterwards is the
 * administrator's explicit decision, saved and audited.
 */
import { useEffect, useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHrWrite } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Draft = {
  early_clock_in_minutes: string;
  late_threshold_minutes: string;
  missed_clock_out_hours: string;
  gps_attendance_enabled: boolean;
  gps_consent_notice: string;
  biometric_configured: boolean;
  qr_attendance_enabled: boolean;
  qr_token_ttl_seconds: string;
  leave_year_start_month: string;
  probation_default_months: string;
  document_retention_months: string;
  external_payroll_configured: boolean;
  ai_assistant_enabled: boolean;
};

function toDraft(s: Row): Draft {
  const n = (k: string) => String(Number(s[k] ?? 0));
  return {
    early_clock_in_minutes: n("early_clock_in_minutes"),
    late_threshold_minutes: n("late_threshold_minutes"),
    missed_clock_out_hours: n("missed_clock_out_hours"),
    gps_attendance_enabled: Boolean(s["gps_attendance_enabled"]),
    gps_consent_notice: String(s["gps_consent_notice"] ?? ""),
    biometric_configured: Boolean(s["biometric_configured"]),
    qr_attendance_enabled: Boolean(s["qr_attendance_enabled"]),
    qr_token_ttl_seconds: n("qr_token_ttl_seconds"),
    leave_year_start_month: n("leave_year_start_month"),
    probation_default_months: n("probation_default_months"),
    document_retention_months: n("document_retention_months"),
    external_payroll_configured: Boolean(s["external_payroll_configured"]),
    ai_assistant_enabled: Boolean(s["ai_assistant_enabled"]),
  };
}

/** Shown when the organisation has no HR settings row yet. */
export function HrSettingsInitialise() {
  const write = useHrWrite("hr_settings", { action: "hr.settings.initialised" });
  return (
    <SectionCard
      title="HR settings not initialised"
      description="This organisation has no HR settings record yet, so attendance tolerance, leave year, document retention and payroll integration cannot be applied. Creating it writes the standard starting values, which you can then change below."
    >
      <Button onClick={() => write.mutate({ values: {} })} disabled={write.isPending}>
        {write.isPending ? "Creating…" : "Initialise HR settings"}
      </Button>
    </SectionCard>
  );
}

export function HrSettingsForm({ settings }: { settings: Row }) {
  const write = useHrWrite("hr_settings", { action: "hr.settings.updated" });
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));

  useEffect(() => {
    setDraft(toDraft(settings));
  }, [settings]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const int = (v: string, min: number, max: number) => {
      const parsed = Math.trunc(Number(v));
      if (!Number.isFinite(parsed)) return min;
      return Math.min(max, Math.max(min, parsed));
    };
    write.mutate({
      id: String(settings["id"]),
      values: {
        early_clock_in_minutes: int(draft.early_clock_in_minutes, 0, 240),
        late_threshold_minutes: int(draft.late_threshold_minutes, 0, 240),
        missed_clock_out_hours: int(draft.missed_clock_out_hours, 1, 48),
        gps_attendance_enabled: draft.gps_attendance_enabled,
        gps_consent_notice: draft.gps_consent_notice.trim(),
        biometric_configured: draft.biometric_configured,
        qr_attendance_enabled: draft.qr_attendance_enabled,
        qr_token_ttl_seconds: int(draft.qr_token_ttl_seconds, 15, 3600),
        leave_year_start_month: int(draft.leave_year_start_month, 1, 12),
        probation_default_months: int(draft.probation_default_months, 0, 24),
        document_retention_months: int(draft.document_retention_months, 1, 240),
        external_payroll_configured: draft.external_payroll_configured,
        ai_assistant_enabled: draft.ai_assistant_enabled,
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Attendance rules"
          description="How early a shift may be started, when a clock-in counts as late and when a missing clock-out is flagged for correction."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Early clock-in allowance (minutes)"
              value={draft.early_clock_in_minutes}
              onChange={(v) => set("early_clock_in_minutes", v)}
            />
            <NumberField
              label="Late threshold (minutes)"
              value={draft.late_threshold_minutes}
              onChange={(v) => set("late_threshold_minutes", v)}
            />
            <NumberField
              label="Missed clock-out flag (hours)"
              value={draft.missed_clock_out_hours}
              onChange={(v) => set("missed_clock_out_hours", v)}
            />
            <NumberField
              label="QR code validity (seconds)"
              value={draft.qr_token_ttl_seconds}
              onChange={(v) => set("qr_token_ttl_seconds", v)}
            />
          </div>

          <div className="mt-4 space-y-3">
            <ToggleRow
              label="GPS attendance"
              hint="Record location when staff clock in or out."
              checked={draft.gps_attendance_enabled}
              onChange={(v) => set("gps_attendance_enabled", v)}
            />
            <ToggleRow
              label="QR clock-in"
              hint="Allow clocking in by scanning a station code."
              checked={draft.qr_attendance_enabled}
              onChange={(v) => set("qr_attendance_enabled", v)}
            />
            <ToggleRow
              label="Biometric device configured"
              hint="Set this only once a device is actually installed and enrolled."
              checked={draft.biometric_configured}
              onChange={(v) => set("biometric_configured", v)}
            />
          </div>

          {draft.gps_attendance_enabled ? (
            <div className="mt-4 space-y-1">
              <Label htmlFor="gps-notice">Location consent notice shown to staff</Label>
              <Textarea
                id="gps-notice"
                rows={3}
                value={draft.gps_consent_notice}
                onChange={(e) => set("gps_consent_notice", e.target.value)}
                placeholder="Write the wording your staff will see before location is recorded."
              />
              <p className="text-xs text-muted-foreground">
                Required wording is a decision for your organisation — it is never written for you.
              </p>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Leave, records & payroll"
          description="The leave year, default probation, how long staff records are kept and whether payroll is handled outside this system."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Leave year starts</Label>
              <Select
                value={draft.leave_year_start_month}
                onValueChange={(v) => set("leave_year_start_month", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <NumberField
              label="Default probation (months)"
              value={draft.probation_default_months}
              onChange={(v) => set("probation_default_months", v)}
            />
            <NumberField
              label="Document retention (months)"
              value={draft.document_retention_months}
              onChange={(v) => set("document_retention_months", v)}
            />
          </div>

          <div className="mt-4 space-y-3">
            <ToggleRow
              label="Payroll handled outside this system"
              hint="Turn on only when an external payroll service is genuinely in use."
              checked={draft.external_payroll_configured}
              onChange={(v) => set("external_payroll_configured", v)}
            />
            <ToggleRow
              label="Workforce assistant"
              hint="Advisory guidance for managers. It never approves anything on its own."
              checked={draft.ai_assistant_enabled}
              onChange={(v) => set("ai_assistant_enabled", v)}
            />
          </div>
        </SectionCard>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={write.isPending}>
          {write.isPending ? "Saving…" : "Save HR settings"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setDraft(toDraft(settings))}
          disabled={write.isPending}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `hr-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/70 p-3">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
