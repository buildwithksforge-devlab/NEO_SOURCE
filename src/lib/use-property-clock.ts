import {useAuth} from '@/lib/auth';
import {useTenant} from '@/lib/tenant';
import {useBranches} from '@/lib/branches';
import {useActivePropertyFilter} from '@/lib/branch-filter';
import {propertyTimeZone} from '@/lib/property-clock';

export function usePropertyClock(recordBranchId?:string|null){
  const {organizationId}=useAuth();
  const {tenant,hydrated}=useTenant();
  const branches=useBranches();
  const scope=useActivePropertyFilter();
  if(!hydrated||branches.isLoading||branches.isError)return {timeZone:null};
  try{return {timeZone:propertyTimeZone(branches.data??[],recordBranchId===undefined?scope.branchId:recordBranchId,organizationId,tenant.regional.timezone)}}
  catch{return {timeZone:null}}
}
