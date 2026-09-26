/**
 * HR-owned official staff identity: photo and mobile number.
 *
 * The image is written to the canonical profile record, mirrored onto the HR
 * employee record by the database, and audited with actor, target and the
 * before/after path. Staff without the staff-photo capability see the picture
 * but get no controls.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Save, Trash2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Avatar } from "@/components/common/AvatarDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCanManageStaffPhotos, useSetStaffPhone, useSetStaffPhoto } from "@/lib/staff-photos";

export function StaffPhotoCard({
  employeeId,
  profileId,
  fullName,
  avatarPath,
  phone,
}: {
  employeeId: string;
  profileId: string | null;
  fullName: string;
  avatarPath: string | null;
  phone?: string | null;
}) {
  const canManage = useCanManageStaffPhotos();
  const setPhoto = useSetStaffPhoto();
  const setPhone = useSetStaffPhone();
  const [phoneDraft, setPhoneDraft] = useState(phone ?? "");

  useEffect(() => {
    setPhoneDraft(phone ?? "");
  }, [phone]);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function apply(file: File | null) {
    setBusy(true);
    try {
      await setPhoto.mutateAsync({
        target: { profileId, employeeId, currentPath: avatarPath },
        file,
      });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <SectionCard
      title="Official staff photo and mobile number"
      description="One HR-owned identity, used across Users, assignments, tasks, approvals, dispatch and operational rosters."
    >
      <div className="flex flex-wrap items-center gap-4">
        <Avatar path={avatarPath} name={fullName} size={72} />
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void apply(file);
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Camera className="mr-2 size-4" />}
              {avatarPath ? "Replace photo" : "Upload photo"}
            </Button>
            {avatarPath ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void apply(null)}>
                <Trash2 className="mr-2 size-4" /> Remove
              </Button>
            ) : null}
            <p className="w-full text-xs text-muted-foreground">
              JPEG, PNG or WebP up to 5 MB. Every change is recorded in the audit trail.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only Human Resources, the Owner/Director and IT/System Administrators may change this photo or mobile number.
          </p>
        )}
      </div>

      <div className="mt-4 space-y-2 border-t border-border/70 pt-4">
        <Label htmlFor={`staff-phone-${employeeId}`}>Official mobile number</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`staff-phone-${employeeId}`}
            className="max-w-xs"
            value={phoneDraft}
            readOnly={!canManage}
            disabled={!canManage}
            placeholder="Not recorded"
            onChange={(e) => setPhoneDraft(e.target.value)}
          />
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={setPhone.isPending || phoneDraft.trim() === (phone ?? "").trim()}
              onClick={() =>
                setPhone.mutate({ target: { profileId, employeeId }, phone: phoneDraft })
              }
            >
              {setPhone.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
              Save number
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          The staff member cannot change this on their own profile. Saving updates their account, HR record and every
          operational surface at once, and is recorded in the audit trail.
        </p>
      </div>
    </SectionCard>
  );
}
