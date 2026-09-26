/**
 * Delivery pickup point for a property.
 *
 * Rider distances are measured between this point and where each delivery was
 * confirmed. Nothing is inferred: when the coordinates are blank the staff
 * board reports distances as "Not measured".
 */
import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function PickupPointCard({ canEdit }: { canEdit: boolean }) {
  const { branchId } = useActivePropertyFilter();
  const qc = useQueryClient();
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  const branch = useQuery({
    queryKey: ["delivery", "pickup-point", branchId ?? "none"],
    enabled: Boolean(branchId),
    queryFn: async () => {
      const { data, error } = await db
        .from("branches")
        .select("id, name, pickup_latitude, pickup_longitude")
        .eq("id", branchId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as {
        id: string;
        name: string;
        pickup_latitude: number | null;
        pickup_longitude: number | null;
      } | null;
    },
  });

  useEffect(() => {
    setLat(branch.data?.pickup_latitude == null ? "" : String(branch.data.pickup_latitude));
    setLng(branch.data?.pickup_longitude == null ? "" : String(branch.data.pickup_longitude));
  }, [branch.data?.pickup_latitude, branch.data?.pickup_longitude]);

  const save = useMutation({
    mutationFn: async () => {
      if (!branchId) throw new Error("Select a property first.");
      const latValue = lat.trim() === "" ? null : Number(lat);
      const lngValue = lng.trim() === "" ? null : Number(lng);
      if (latValue !== null && (!Number.isFinite(latValue) || latValue < -90 || latValue > 90)) {
        throw new Error("Latitude must be between -90 and 90.");
      }
      if (lngValue !== null && (!Number.isFinite(lngValue) || lngValue < -180 || lngValue > 180)) {
        throw new Error("Longitude must be between -180 and 180.");
      }
      if ((latValue === null) !== (lngValue === null)) {
        throw new Error("Enter both coordinates, or leave both blank.");
      }
      const { error } = await db
        .from("branches")
        .update({ pickup_latitude: latValue, pickup_longitude: lngValue })
        .eq("id", branchId);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      toast.success("Pickup point saved.");
      await qc.invalidateQueries({ queryKey: ["delivery"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <SectionCard
      title="Delivery pickup point"
      description="The exact location riders collect from. Distances on the staff board are measured from here; leave blank if it is not known."
      icon={MapPin}
    >
      <QueryState
        isLoading={branch.isLoading}
        error={branch.error}
        isEmpty={!branchId}
        empty="Select a property to set its pickup point."
      >
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="pickup-lat">Latitude</Label>
            <Input
              id="pickup-lat"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="-1.2921"
              disabled={!canEdit}
              inputMode="decimal"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pickup-lng">Longitude</Label>
            <Input
              id="pickup-lng"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="36.8219"
              disabled={!canEdit}
              inputMode="decimal"
            />
          </div>
          <Button onClick={() => save.mutate()} disabled={!canEdit || save.isPending}>
            {save.isPending ? "Saving…" : "Save pickup point"}
          </Button>
        </div>
      </QueryState>
    </SectionCard>
  );
}
