import {describe,it,expect,vi} from 'vitest';
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));vi.mock('@/lib/auth',()=>({useAuth:()=>({})}));vi.mock('@/lib/branch-filter',()=>({useActivePropertyFilter:()=>({})}));
import {currentStationId} from '../station-stock';
describe('current station assignment',()=>{
 it('retains an assigned selection',()=>expect(currentStationId('b',[{stationId:'a'},{stationId:'b'}])).toBe('b'));
 it('switches immediately when the old station leaves the property assignment list',()=>expect(currentStationId('old',[{stationId:'new'}])).toBe('new'));
 it('does not query a previously selected station while assignments are loading or removed',()=>expect(currentStationId('old',[])).toBeNull());
 it('selects the primary ordered station on first load',()=>expect(currentStationId(null,[{stationId:'primary'}])).toBe('primary'));
});
