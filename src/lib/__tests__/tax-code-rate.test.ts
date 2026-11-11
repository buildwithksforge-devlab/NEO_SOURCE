import {describe,it,expect} from 'vitest';
import {formatTaxCodeRate,taxCodeFractionFromPercent} from '@/lib/tax-code-rate';
describe('explicit Finance tax-code fraction units',()=>{
 it.each([[16,0.16],[0.16,0.0016],[0,0],[100,1],[7.25,0.0725]])('stores %s percent as its fraction',(percent,fraction)=>expect(taxCodeFractionFromPercent(percent)).toBe(fraction));
 it.each([null,undefined,'',-1,101,'NaN',Infinity,'wrong',16.125])('rejects invalid percentage %s',value=>expect(()=>taxCodeFractionFromPercent(value)).toThrow());
 it('displays the installed VAT16 seed as 16 percent',()=>expect(formatTaxCodeRate(0.16)).toBe('16%'));
 it('does not guess ambiguous or missing stored units',()=>{expect(formatTaxCodeRate(16)).toBe('Review stored rate');expect(formatTaxCodeRate(null)).toBe('Not recorded')});
});
