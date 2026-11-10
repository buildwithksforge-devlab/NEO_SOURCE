import {menuDepartmentsForBranch,type MenuDepartment} from '@/lib/menu-scoping';

export function stationDepartmentOptions(departments: MenuDepartment[], branchId: string | null) {
  return menuDepartmentsForBranch(branchId ? departments : departments.filter(d=>d.branch_id===null),branchId);
}
export function assertStationPlacement(name: string, branchId: string, departmentId: string, departments: MenuDepartment[]) {
  if (!name.trim()) throw Error('Enter a station name.');
  if (!branchId || !departmentId || !stationDepartmentOptions(departments,branchId).some(d=>d.id===departmentId)) {
    throw Error('Choose a property and one of its active departments. Refresh if the department changed.');
  }
}
export function confirmStationWrite(data: {id?: string} | null, error: {message?: string} | null, expectedId?: string) {
  if (error) throw Error(error.message || 'Station could not be saved.');
  if (!data?.id || (expectedId && data.id!==expectedId)) throw Error('Station save was not confirmed. Refresh before retrying.');
  return data.id;
}
