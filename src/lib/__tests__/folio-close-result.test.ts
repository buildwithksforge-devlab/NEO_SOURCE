import {describe,it,expect} from 'vitest';
import {requireFolioCloseResult} from '../folio-close-result';
describe('folio close evidence',()=>{
 it.each([null,undefined,false,{}, {ok:false,reason:'balance_outstanding'},{ok:false,reason:'pending_payments'},{ok:true,folio_id:'other',status:'closed',balance:0},{ok:true,folio_id:'folio',status:'open',balance:0},{ok:true,folio_id:'folio',status:'closed',balance:10},{ok:true,folio_id:'folio',status:'closed',balance:null}])('does not announce an unverified closure: %j',value=>expect(()=>requireFolioCloseResult(value,'folio')).toThrow());
 it('accepts a saved zero-balance closure',()=>{const value={ok:true,folio_id:'folio',status:'closed',balance:0};expect(requireFolioCloseResult(value,'folio')).toBe(value)});
 it('accepts the installed idempotent response',()=>expect(requireFolioCloseResult({ok:true,folio_id:'folio',reason:'already_closed'},'folio')).toBeTruthy());
});
