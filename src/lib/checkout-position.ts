import {useQuery} from "@tanstack/react-query";
import {useAuth} from "./auth";
import {supabase} from "@/integrations/supabase/client";
import {guardedRpc} from "./rpc-guard";
import {checkoutPosition,mapCheckoutFolio} from "./checkout-reconciliation";
import {useActivePropertyFilter} from "./branch-filter";

export function useCheckoutPosition(reservationId:string,enabled:boolean){
  const {organizationId,user,permissionsLoaded}=useAuth();
  const {branchId,filterKey}=useActivePropertyFilter();
  return useQuery({
    queryKey:["pms","checkout-position",organizationId,user?.id,reservationId,filterKey],
    enabled:enabled&&Boolean(organizationId&&user&&permissionsLoaded),
    staleTime:0,
    queryFn:async()=>{
      if(!organizationId)throw new Error("Organization required to review checkout.");
      const {data:stay,error:stayError}=await supabase.from("stays").select("id,branch_id")
        .eq("organization_id",organizationId).eq("reservation_id",reservationId).maybeSingle();
      if(stayError)throw stayError;
      if(!stay?.branch_id)throw new Error("Stay not available in your property scope.");
      if(branchId&&stay.branch_id!==branchId)throw new Error("Stay belongs to a different selected property.");
      const {data:folios,error:folioError}=await supabase.from("folios")
        .select("id,branch_id,reservation_id,folio_number,folio_type,currency,status")
        .eq("organization_id",organizationId).eq("stay_id",stay.id).order("id");
      if(folioError)throw folioError;
      const positions=await Promise.all((folios??[]).map(async(row)=>{
        if(row.reservation_id&&row.reservation_id!==reservationId)throw new Error("Folio belongs to a different reservation.");
        const {data,error}=await guardedRpc(supabase,"neo_folio_projection",{_folio:row.id});
        if(error)throw error;
        return mapCheckoutFolio(row,data,stay.branch_id);
      }));
      return checkoutPosition(positions);
    },
  });
}
