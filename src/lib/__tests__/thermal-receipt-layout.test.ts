import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFPage, PrintScaling } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildThermalReceiptPdf } from '@/lib/document-thermal-pdf.server';
import { buildBusinessDocumentPdf } from '@/lib/document-pdf.server';
import { NEO_SYMBOL_BASE64 } from '@/lib/document-symbol';
afterEach(()=>vi.restoreAllMocks());
const baseline={document:{number:'LAYOUT-ONLY-001',date:'2026-11-10T12:00:00Z',status:'closed'},property:{name:'Sample Property',currency:'KES'},identity:{organisation:'Sample Company',organisation_id:'a6000000-0000-4000-8000-000000000001'},branch_id:'a6000000-0000-4000-8000-000000000002',generated_at:'2026-11-10T12:30:00Z',party:{label:'Guest',name:'Layout sample'},lines:[{description:'Lunch',quantity:1,unit_price:1854,total:1854}],totals:[{label:'Total',amount:1854,emphasis:true},{label:'Tendered',amount:2000},{label:'Change',amount:146}],meta:{cashier:'Sample cashier'}};
describe('thermal receipt actual PDF layout',()=>{
 for(const variant of ['standard','long-labels','wrapped-items','charged-to-room','branded-long','split-tender'])it(variant+' keeps text and rules apart',async()=>{
  const payload=structuredClone(baseline);
  if(variant==='long-labels'){payload.party.name='Guest with a very long name that must stay inside the receipt';payload.meta={cashier:'Cashier name with several long words',original_external_payment_confirmation_reference:'A'.repeat(70)} as any;payload.totals.unshift({label:'Remaining balance after previous confirmed payments',amount:1854,emphasis:false});}
  if(variant==='wrapped-items'){payload.lines=[{description:'Very long item description WITHANUNBROKENIDENTIFIERTHATSHOULDWRAP on the receipt',quantity:2,unit_price:927,total:1854,note:'A long preparation note that wraps across several lines without touching the following row'} as any];}
  if(variant==='charged-to-room'){
   payload.document.status='charged-to-room';
   payload.totals=[{label:'Total',amount:1854,emphasis:true},{label:'Paid',amount:1000},{label:'Balance',amount:854}];
  }
  if (variant === "split-tender") {
   payload.totals = [{label:"Total",amount:1854,emphasis:true},
    {label:"Cash",amount:1000,emphasis:false},{label:"Cash",amount:854,emphasis:false}];
  }
  if(variant==='branded-long') {
   Object.assign(payload.identity,{brand:{logoLight:'data:image/png;base64,'+NEO_SYMBOL_BASE64,
    receiptFeedbackUrl:'https://property.example/feedback', receiptPaybill:'123456',receiptPaybillAccount:'ORDER',
    receiptTill:'654321',receiptPaymentInstructions:'Use the amount shown on this receipt.'}});
   Object.assign(payload.meta,{Waiter:'Sample waiter','Collected by':'Sample cashier','Checked by':'Sample manager'});
   payload.lines=Array.from({length:42},(_,index)=>({description:`Lunch item ${index+1} with a wrapping description`,quantity:1,unit_price:45,total:45}));
   payload.totals=[
    {label:"Net before tax",amount:1601.88},{label:"VAT · Included",amount:256.20},
    {label:"Catering levy · Included",amount:31.92},{label:"Total",amount:1890,emphasis:true},
    {label:"Tendered",amount:2000},{label:"Change",amount:110},
   ];
  }
  const texts:any[]=[],rules:any[]=[];
  const drawText=PDFPage.prototype.drawText,drawLine=PDFPage.prototype.drawLine;
  vi.spyOn(PDFPage.prototype,'drawText').mockImplementation(function(this: PDFPage,text: string,options:any){const o=options??{};const ascent=o.font.heightAtSize(o.size,{descender:false}),height=o.font.heightAtSize(o.size);texts.push({page:this,text,size:o.size,left:o.x,right:o.x+o.font.widthOfTextAtSize(text,o.size),top:o.y+ascent,bottom:o.y-(height-ascent)});return drawText.call(this,text,options)});
  vi.spyOn(PDFPage.prototype,'drawLine').mockImplementation(function(this: PDFPage,options:any){rules.push({page:this,...options});return drawLine.call(this,options)});
  const rpc=vi.fn().mockResolvedValue({data:payload,error:null});
  const result=await buildThermalReceiptPdf({rpc} as any,{type:'pos_receipt',id:'sample'});
  if(process.env['RECEIPT_EVIDENCE_DIR']){mkdirSync(process.env['RECEIPT_EVIDENCE_DIR'],{recursive:true});writeFileSync(process.env['RECEIPT_EVIDENCE_DIR']+'/'+variant+'.pdf',Buffer.from(result.base64,'base64'));}
  expect(rpc).toHaveBeenCalledExactlyOnceWith('neo_document_payload',{_type:'pos_receipt',_id:'sample'});
  for(const t of texts){expect(t.left,t.text+' left').toBeGreaterThanOrEqual(11.5);expect(t.right,t.text+' right').toBeLessThanOrEqual(215.27);expect(t.bottom,t.text+' bottom').toBeGreaterThan(5);}
  const collisions=texts.flatMap(t=>rules.filter(r=>r.page===t.page&&r.start.y===r.end.y&&r.start.y>t.bottom-0.3&&r.start.y<t.top+0.3&&r.end.x>t.left&&r.start.x<t.right).map(()=>t.text));
  expect(collisions,'horizontal rules must not cross glyphs').toEqual([]);
  const overlaps=texts.flatMap((a,i)=>texts.slice(i+1).filter(b=>a.page===b.page&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5&&Math.min(a.top,b.top)-Math.max(a.bottom,b.bottom)>0.5).map(b=>[a.text,b.text]));
  expect(overlaps,'text blocks must not overlap').toEqual([]);
  if(variant==='charged-to-room'){
   const rendered=texts.map(t=>t.text).join(' ');
   expect(rendered).toContain('Paid at POS');
   expect(rendered).toContain('Transferred to guest folio');
  }
  if (variant === "split-tender") expect(texts.filter((entry) => entry.text === "Cash")).toHaveLength(2);
  if(variant==='branded-long'){
   const rendered=texts.map(t=>t.text);
   expect(rendered).toContain('SCAN TO LEAVE FEEDBACK');
   expect(rendered).toContain('M-Pesa Paybill:');
   expect(rendered).toContain('M-Pesa Till:');
   expect(rendered).toContain('TAX BREAKDOWN');
   expect(rendered).toContain('Total tax');
   expect(rendered).toContain('KES 288.12');
   expect(rendered.indexOf('Total tax')).toBeLessThan(rendered.indexOf('TOTAL'));
   expect(rendered.indexOf('Served by:')).toBeGreaterThan(rendered.indexOf('HOW TO PAY'));
   const pdf=await PDFDocument.load(Buffer.from(result.base64,'base64'));
   expect(pdf.getPageCount()).toBeGreaterThan(2);
   for (const page of pdf.getPages()) {
    expect(page.getWidth()).toBeCloseTo(226.77);
    expect(page.getHeight()).toBeLessThanOrEqual(841.9);
   }
   expect(rendered).toContain("Receipt LAYOUT-ONLY-001 · page 2");
   const itemRows = texts.filter((entry) => /^Lunch item \d+ /.test(entry.text));
   expect(itemRows).toHaveLength(42);
   expect(new Set(itemRows.map((entry) => entry.size))).toEqual(new Set([8.5]));
   expect(new Set(itemRows.map((entry) => entry.page)).size).toBeGreaterThan(1);
   expect(pdf.catalog.getViewerPreferences()?.getPrintScaling()).toBe(PrintScaling.None);
  }
 });

 it.each(["stock_sheet","invoice","requisition","goods_receipt"] as const)("keeps long %s on fixed A4 pages", async (type)=>{
  const payload={...baseline,property:{...baseline.property,timezone:"Africa/Nairobi"},
   document:{...baseline.document,title:type.replace("_"," ")},
   lines:Array.from({length:70},(_,index)=>({description:`Sample line ${index+1} with enough detail for the print layout`,
    quantity:2,unit:"pc",unit_price:10,total:20,note:"Count and confirm the stock on this row."}))};
  const result=await buildBusinessDocumentPdf({rpc:vi.fn().mockResolvedValue({data:payload,error:null}),
   from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{}})})})})} as any,{type,id:"sample"});
  const bytes=Buffer.from(result.base64,"base64");
  const pdf=await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThan(2);
  for(const page of pdf.getPages()){
   expect(page.getWidth()).toBeCloseTo(595.28);
   expect(page.getHeight()).toBeCloseTo(841.89);
  }
  expect(pdf.catalog.getViewerPreferences()?.getPrintScaling()).toBe(PrintScaling.None);
  if(process.env['RECEIPT_EVIDENCE_DIR']){mkdirSync(process.env['RECEIPT_EVIDENCE_DIR'],{recursive:true});writeFileSync(process.env['RECEIPT_EVIDENCE_DIR']+'/'+type+'.pdf',bytes);}
 });
});
