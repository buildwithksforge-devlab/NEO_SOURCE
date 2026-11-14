import {describe,it,expect} from 'vitest';
import {convertStrict,canConvert,consumptionForSale,expandRecipeToStock,aggregateComponents,wholeUnitIssue,type RecipeRecord} from '@/lib/recipe-engine';
const recipe:RecipeRecord={id:'r',status:'active',recipe_type:'menu_item',yield_quantity:1,yield_unit:'portion',ingredients:[{id:'i',component_type:'stock_item',stock_item_id:'beans',quantity:18,unit:'g'}]};
const map=(r=recipe)=>new Map([[r.id,r]]);
describe('recipe preview/configuration boundaries',()=>{
 for(const unit of ['', '   '])it('missing source/target unit is not a successful conversion',()=>{expect(canConvert(unit,'g')).toBe(false);expect(canConvert('g',unit)).toBe(false);expect(()=>convertStrict(1,unit,'g')).toThrow()});
 for(const qty of [NaN,Infinity,-1])it('invalid sold quantity cannot silently produce an empty/invalid consumption preview',()=>{expect(()=>consumptionForSale(map(),'r',qty,()=> 'g')).toThrow()});
 for(const yieldQuantity of [NaN,Infinity,0,-1])it('requires a finite positive recipe yield',()=>{expect(()=>consumptionForSale(map({...recipe,yield_quantity:yieldQuantity}),'r',1,()=> 'g')).toThrow(/yield/)});
 for(const qty of [NaN,Infinity,-1])it('invalid ingredient quantity is rejected',()=>{expect(()=>expandRecipeToStock(map({...recipe,ingredients:[{...recipe.ingredients[0]!,quantity:qty}]}),'r',1)).toThrow()});
 it('rejects negative or nonfinite waste allowances',()=>{for(const waste of [-1,NaN,Infinity])expect(()=>expandRecipeToStock(map({...recipe,ingredients:[{...recipe.ingredients[0]!,waste_allowance:waste}]}),'r',1)).toThrow()});
 it('rejects numeric overflow in both expansion and aggregation',()=>{
  expect(()=>expandRecipeToStock(map({...recipe,ingredients:[{...recipe.ingredients[0]!,quantity:1e308}]}),'r',100)).toThrow(/large/);
  expect(()=>aggregateComponents([{stockItemId:'x',quantity:1e308,unit:'g',kind:'use'},{stockItemId:'x',quantity:1e308,unit:'g',kind:'use'}],()=> 'g')).toThrow(/large/);
 });
 it('valid zero sale, measured conversion and independent waste behavior remain available',()=>{
  expect(consumptionForSale(map(),'r',0,()=> 'g')).toEqual([]);
  expect(convertStrict(1,'kg','g')).toBe(1000);
  expect(consumptionForSale(map(),'r',2,()=> 'g')[0]?.quantity).toBe(36);
 });
 it('ingredient editor reports invalid measured and whole quantities',()=>{
  expect(wholeUnitIssue(NaN,'g')).toMatch(/finite/);expect(wholeUnitIssue(-1,'piece')).toMatch(/non-negative/);
  expect(wholeUnitIssue(0.5,'kg')).toBeNull();
 });
});
