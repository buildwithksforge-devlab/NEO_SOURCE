import {describe,expect,it} from "vitest";
import {directSaleDraftMapping,recipeStockMappingIssue} from "../recipe-stock-mapping";
const valid = () => ({recipe_type:"direct_sale",status:"active",organization_id:"hotel",branch_id:"branch",
  menu_item_id:"menu",output_stock_item_id:"redbull",yield_quantity:1,yield_unit:"pc",
  output_stock_item:{id:"redbull",organization_id:"hotel",branch_id:"branch"},
  menu_items:{id:"menu",organization_id:"hotel",branch_id:"branch",consumption_mode:"direct_stock",stock_item_id:"redbull",stock_quantity_per_sale:1,stock_unit:"pc"}});
describe("direct-sale mapping readiness",()=>{
  it("seeds a corrective draft from existing owned menu stock without changing its old recipe",()=>{
    const row={...valid(),output_stock_item:null,output_stock_item_id:"foreign-stock",
      menu_items:{...valid().menu_items,name:"Red Bull",stock_item_id:"owned-can",stock_unit:"Can",
        mapped_stock_item:{id:"owned-can",organization_id:"hotel",branch_id:"branch"}}};
    expect(directSaleDraftMapping(row)).toEqual({name:"Red Bull",stockItemId:"owned-can",quantity:1,unit:"Can"});
    expect(row.output_stock_item_id).toBe("foreign-stock");
  });
  it("does not seed a draft from foreign, hidden or wrong-property menu stock",()=>{
    for(const stock of [null,{id:"redbull",organization_id:"foreign",branch_id:"branch"},{id:"redbull",organization_id:"hotel",branch_id:"elsewhere"}]) {
      expect(directSaleDraftMapping({...valid(),menu_items:{...valid().menu_items,mapped_stock_item:stock}})).toBeNull();
    }
  });
  it("accepts matching stock/menu ownership, quantity and units",()=>{
    expect(recipeStockMappingIssue(valid())).toBeNull();
    expect(recipeStockMappingIssue({...valid(),menu_items:{...valid().menu_items,stock_unit:"PC"}})).toBeNull();
  });
  it("flags a menu pointing at water even when the recipe stock name is visible",()=>{
    expect(recipeStockMappingIssue({...valid(),menu_items:{...valid().menu_items,stock_item_id:"water"}})).toContain("different stock mappings");
  });
  it("flags foreign organisation and property stock",()=>{
    expect(recipeStockMappingIssue({...valid(),output_stock_item:{...valid().output_stock_item,organization_id:"another-hotel"}})).toContain("another organisation");
    expect(recipeStockMappingIssue({...valid(),output_stock_item:{...valid().output_stock_item,branch_id:"another-property"}})).toContain("another property");
  });
  it("does not certify an RLS-hidden output or menu",()=>{
    expect(recipeStockMappingIssue({...valid(),output_stock_item:null})).toContain("unavailable");
    expect(recipeStockMappingIssue({...valid(),menu_items:null})).toContain("unavailable");
  });
  it("flags stale menu quantities and unit conversions needing review",()=>{
    expect(recipeStockMappingIssue({...valid(),menu_items:{...valid().menu_items,stock_quantity_per_sale:9}})).toContain("quantity or unit differs");
    expect(recipeStockMappingIssue({...valid(),menu_items:{...valid().menu_items,stock_unit:"can"}})).toContain("quantity or unit differs");
    expect(recipeStockMappingIssue({...valid(),yield_quantity:NaN})).toContain("positive quantity");
  });
  it("allows an owned draft to differ from the still-approved menu binding",()=>{
    expect(recipeStockMappingIssue({...valid(),status:"draft",menu_items:{...valid().menu_items,stock_item_id:"water"}})).toBeNull();
  });
});
