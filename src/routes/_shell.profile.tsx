import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { DensityPreferenceControl } from "@/components/common/DensityPreference";

import { AvatarUploader } from "@/components/common/AvatarDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useCanManageStaffPhotos } from "@/lib/staff-photos";
import { NotConfiguredState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/profile")({
  head: () => ({
    meta: [
      { title: "My Profile — NEØ Operations" },
      {
        name: "description",
        content: "Your NEØ account: profile photo, contact details, role, department and property.",
      },
      { property: "og:title", content: "My Profile — NEØ Operations" },
      {
        property: "og:description",
        content: "Your NEØ account: profile photo, contact details, role, department and property.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MyProfile,
});

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function MyProfile() {
  const { profile, roleNames, refresh, access } = useAuth();
  const { branches } = useBranchScope();
  const canManagePhotos = useCanManageStaffPhotos();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFullName(profile?.full_name ?? "");
    setPhone(profile?.phone ?? "");
  }, [profile?.full_name, profile?.phone]);

  const department = useQuery({
    queryKey: ["my-department", profile?.department_id ?? "none"],
    enabled: Boolean(profile?.department_id),
    queryFn: async () => {
      const { data } = await supabase
        .from("departments")
        .select("name")
        .eq("id", profile!.department_id!)
        .maybeSingle();
      return (data?.name as string | undefined) ?? null;
    },
  });

  if (!profile) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="My account" title="My Profile" />
        <SectionCard title="Profile">
          <NotConfiguredState
            feature="Your staff profile"
            detail="Your login is not yet linked to a staff profile. Ask an administrator to complete your account setup."
            inline
          />
        </SectionCard>
      </div>
    );
  }

  const branchName = branches.find((b) => b.id === profile.branch_id)?.name ?? "Not assigned";

  async function persist(patch: {
    full_name?: string;
    phone?: string;
    avatar_url?: string | null;
  }) {
    const { error } = await supabase.from("profiles").update(patch).eq("id", profile!.id);
    if (error) throw new Error(error.message);
    await refresh();
  }

  async function saveDetails() {
    setSaving(true);
    try {
      await persist(
        canManagePhotos
          ? { full_name: fullName.trim(), phone: phone.trim() }
          : { full_name: fullName.trim() },
      );
      toast.success("Profile updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="My account"
        title="My Profile"
        description="Your name and photo are yours to maintain. Your official mobile number, role, department, property and employment status stay under HR and administrator control."
      />

      <SectionCard
        title="Your photo"
        description="Upload your own photo. It appears wherever you are shown across NEØ — rosters, tasks, approvals and dispatch. Your official mobile number stays with Human Resources."
      >
        <AvatarUploader
          path={profile.avatar_url}
          name={profile.full_name}
          onChange={async (next) => {
            await persist({ avatar_url: next });
          }}
        />
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Personal details"
          description={
            canManagePhotos
              ? "Editable by you."
              : "Your name is editable by you. The official mobile number is held on your HR record."
          }
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="full-name">Full name</Label>
              <Input
                id="full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Mobile number</Label>
              <Input
                id="phone"
                value={phone}
                readOnly={!canManagePhotos}
                disabled={!canManagePhotos}
                onChange={(e) => setPhone(e.target.value)}
              />
              {canManagePhotos ? null : (
                <p className="text-xs text-muted-foreground">
                  Held by Human Resources so duty rosters, dispatch and approvals reach the right
                  person.
                </p>
              )}
            </div>
            <Button onClick={() => void saveDetails()} disabled={saving || !fullName.trim()}>
              {saving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              Save changes
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="Work record" description="Maintained by HR and administrators.">
          <dl className="grid">
            <Field label="Staff number" value={profile.staff_id || "Not issued"} />
            <Field label="Work email" value={profile.email || "—"} />
            <Field label="Job title" value={profile.job_title || "Not recorded"} />
            <Field label="Department" value={department.data ?? "Not assigned"} />
            <Field label="Property" value={branchName} />
            <Field label="Employment status" value={profile.employment_status || "Not recorded"} />
            <Field label="Account status" value={profile.account_status || "Not recorded"} />
            <Field label="Access scope" value={access.accessScope} />
            <Field
              label="Last sign-in"
              value={profile.last_login_at ? new Date(profile.last_login_at).toLocaleString() : "—"}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {roleNames.length ? (
              roleNames.map((role) => (
                <Badge key={role} variant="secondary">
                  {role}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">No role assigned</span>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Display density"
          description="A personal display preference. It changes spacing only — never your access or the records you can see."
        >
          <DensityPreferenceControl />
        </SectionCard>

      </div>
    </div>
  );
}
