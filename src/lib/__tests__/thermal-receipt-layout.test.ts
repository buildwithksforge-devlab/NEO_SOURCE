import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFPage } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildThermalReceiptPdf } from '@/lib/document-thermal-pdf.server';
afterEach(()=>vi.restoreAllMocks());
const baseline={document:{number:'LAYOUT-ONLY-001',date:'2026-11-10T12:00:00Z'},property:{name:'Sample Property',currency:'KES'},identity:{organisation:'Sample Company',organisation_id:'a6000000-0000-4000-8000-000000000001'},branch_id:'a6000000-0000-4000-8000-000000000002',generated_at:'2026-11-10T12:30:00Z',party:{label:'Guest',name:'Layout sample'},lines:[{description:'Lunch',quantity:1,unit_price:1854,total:1854}],totals:[{label:'Total',amount:1854,emphasis:true},{label:'Tendered',amount:2000},{label:'Change',amount:146}],meta:{cashier:'Sample cashier'}};
describe('thermal receipt actual PDF layout',()=>{
 for(const variant of ['standard','long-labels','wrapped-items'])it(variant+' keeps text and rules apart',async()=>{
  const payload=structuredClone(baseline);
  if(variant==='long-labels'){payload.party.name='Guest with a very long name that must stay inside the receipt';payload.meta={cashier:'Cashier name with several long words',original_external_payment_confirmation_reference:'A'.repeat(70)} as any;payload.totals.unshift({label:'Remaining balance after previous confirmed payments',amount:1854,emphasis:false});}
  if(variant==='wrapped-items'){payload.lines=[{description:'Very long item description WITHANUNBROKENIDENTIFIERTHATSHOULDWRAP on the receipt',quantity:2,unit_price:927,total:1854,note:'A long preparation note that wraps across several lines without touching the following row'} as any];}
  const texts:any[]=[],rules:any[]=[];
  const drawText=PDFPage.prototype.drawText,drawLine=PDFPage.prototype.drawLine;
  vi.spyOn(PDFPage.prototype,'drawText').mockImplementation(function(this: PDFPage,text: string,options:any){const o=options??{};const ascent=o.font.heightAtSize(o.size,{descender:false}),height=o.font.heightAtSize(o.size);texts.push({text,left:o.x,right:o.x+o.font.widthOfTextAtSize(text,o.size),top:o.y+ascent,bottom:o.y-(height-ascent)});return drawText.call(this,text,options)});
  vi.spyOn(PDFPage.prototype,'drawLine').mockImplementation(function(this: PDFPage,options:any){rules.push(options);return drawLine.call(this,options)});
  const rpc=vi.fn().mockResolvedValue({data:payload,error:null});
  const result=await buildThermalReceiptPdf({rpc} as any,{type:'pos_receipt',id:'sample'});
  if(process.env['RECEIPT_EVIDENCE_DIR']){mkdirSync(process.env['RECEIPT_EVIDENCE_DIR'],{recursive:true});writeFileSync(process.env['RECEIPT_EVIDENCE_DIR']+'/'+variant+'.pdf',Buffer.from(result.base64,'base64'));}
  expect(rpc).toHaveBeenCalledExactlyOnceWith('neo_document_payload',{_type:'pos_receipt',_id:'sample'});
  for(const t of texts){expect(t.left,t.text+' left').toBeGreaterThanOrEqual(11.5);expect(t.right,t.text+' right').toBeLessThanOrEqual(215.27);expect(t.bottom,t.text+' bottom').toBeGreaterThan(5);}
  const collisions=texts.flatMap(t=>rules.filter(r=>r.start.y===r.end.y&&r.start.y>t.bottom-0.3&&r.start.y<t.top+0.3&&r.end.x>t.left&&r.start.x<t.right).map(()=>t.text));
  expect(collisions,'horizontal rules must not cross glyphs').toEqual([]);
  const overlaps=texts.flatMap((a,i)=>texts.slice(i+1).filter(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5&&Math.min(a.top,b.top)-Math.max(a.bottom,b.bottom)>0.5).map(b=>[a.text,b.text]));
  expect(overlaps,'text blocks must not overlap').toEqual([]);
 });
});
