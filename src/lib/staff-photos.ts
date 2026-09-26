/**
 * Official staff photographs.
 *
 * HR owns the operational photo of a staff member: it lives on the canonical
 * profile record (`profiles.avatar_url`), flows to every surface that shows a
 * person, and is mirrored onto the HR employee record by the database. Ordinary
 * staff may see their photo but may not replace or remove it — that authority
 * belongs to the `human-resources.staff-photos.manage` capability, held by HR
 * Managers, Owners/Directors and IT/System Administrators.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { removeAvatarObject, uploadAvatarFor } from "@/lib/avatars";

export const STAFF_PHOTO_MODULE = "human-resources";
export const STAFF_PHOTO_CAPABILITY = "staff-photos.manage";

/** True when the signed-in user may manage another staff member's official photo. */
export function useCanManageStaffPhotos() {
  const { can } = useAuth();
  return can(STAFF_PHOTO_MODULE, STAFF_PHOTO_CAPABILITY);
}

export type StaffPhotoTarget = {
  /** Canonical login/profile id of the staff member, when they have an account. */
  profileId?: string | null;
  /** HR employee record id, used when no login account exists yet. */
  employeeId?: string | null;
  /** The path currently stored, so the superseded object can be removed. */
  currentPath?: string | null;
};

/**
 * Sets, replaces or clears the official photo of a staff member. The database
 * verifies the capability again and records the change with actor, target,
 * before/after path, organisation, property and time.
 */
export function useSetStaffPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, file }: { target: StaffPhotoTarget; file: File | null }) => {
      const owner = target.profileId ?? target.employeeId;
      if (!owner) throw new Error("Select the staff member whose photo is being changed.");
      const path = file ? await uploadAvatarFor(owner, file) : null;
      const { error } = await guardedRpc(supabase, "neo_hr_set_staff_photo", {
        _profile: target.profileId ?? null,
        _employee: target.employeeId ?? null,
        _path: path,
      } as never);
      if (error) {
        if (path) await removeAvatarObject(path);
        throw new Error(error.message);
      }
      if (target.currentPath && target.currentPath !== path) {
        await removeAvatarObject(target.currentPath);
      }
      return path;
    },
    onSuccess: (path) => {
      toast.success(path ? "Official staff photo updated" : "Official staff photo removed");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      void qc.invalidateQueries({ queryKey: ["avatar-url"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Sets the official mobile number of a staff member. The number belongs to the
 * HR record exactly as the photo does: staff may see it, only an authorised
 * manager may change it, the database mirrors it onto the canonical account so
 * Users, rosters, dispatch and approvals all read the same value, and every
 * change is audited.
 */
export function useSetStaffPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, phone }: { target: StaffPhotoTarget; phone: string }) => {
      if (!target.profileId && !target.employeeId) {
        throw new Error("Select the staff member whose mobile number is being changed.");
      }
      const { error } = await guardedRpc(supabase, "neo_hr_set_staff_identity", {
        _profile: target.profileId ?? null,
        _employee: target.employeeId ?? null,
        _path: null,
        _phone: phone.trim(),
        _set_photo: false,
        _set_phone: true,
      } as never);
      if (error) throw new Error(error.message);
      return phone.trim();
    },
    onSuccess: () => {
      toast.success("Official mobile number updated");
      void qc.invalidateQueries({ queryKey: ["hr"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
