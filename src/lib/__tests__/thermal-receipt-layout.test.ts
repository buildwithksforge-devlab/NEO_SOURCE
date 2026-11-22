import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFPage, PrintScaling } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildThermalReceiptPdf } from '@/lib/document-thermal-pdf.server';
import { buildBusinessDocumentPdf } from '@/lib/document-pdf.server';
import { NEO_SYMBOL_BASE64 } from '@/lib/document-symbol';
afterEach(()=>vi.restoreAllMocks());
const baseline={document:{number:'LAYOUT-ONLY-001',date:'2026-11-10T12:00:00Z',status:'closed'},property:{name:'Sample Property',currency:'KES'},identity:{organisation:'Sample Company',organisation_id:'a6000000-0000-4000-8000-000000000001'},branch_id:'a6000000-0000-4000-8000-000000000002',generated_at:'2026-11-10T12:30:00Z',party:{label:'Guest',name:'Layout sample'},lines:[{description:'Lunch',quantity:1,unit_price:1854,total:1854}],totals:[{label:'Total',amount:1854,emphasis:true},{label:'Tendered',amount:2000},{label:'Change',amount:146}],meta:{cashier:'Sample cashier'}};
describe('thermal receipt actual PDF layout',()=>{
 it('keeps a moderate branded QR receipt and its footer on one roll page', async()=>{
  const payload=structuredClone(baseline);
  Object.assign(payload.property,{address:'100 Crown Avenue, Westlands, Nairobi',city:'Nairobi',country:'Kenya',
   timezone:'Africa/Nairobi',
   phone:'+254 20 500 1000',email:'nairobi@savannacrown.example'});
  Object.assign(payload.identity,{tax_id:'P000000000T',brand:{logoLight:'data:image/png;base64,'+NEO_SYMBOL_BASE64,
   receiptQrDestination:'socials',receiptFeedbackUrl:'https://example.com/savanna-crown',
   receiptPaybill:'254254',receiptPaybillAccount:'901393',receiptTill:'102913'}});
  payload.lines=[
   {description:'Heineken 330ml',quantity:3,unit_price:600,total:1800},
   {description:'Balozi',quantity:5,unit_price:350,total:1750},
   {description:'Fish Curry',quantity:1,unit_price:1900,total:1900},
   {description:'Pancakes & Fruit',quantity:1,unit_price:900,total:900},
  ];
  payload.totals=[{label:'Subtotal',amount:6350},{label:'Discount',amount:0},
   {label:'Service charge',amount:0},{label:'Net before tax',amount:5474.13},
   {label:'16% VAT Standard rate (VAT 16%) · Included',amount:875.87},
   {label:'Total',amount:6350,emphasis:true},{label:'Paid',amount:0},{label:'Balance',amount:6350}];
  payload.meta={cashier:'Cynthia Kibet','Payment status':'unpaid'} as any;
  const drawText=vi.spyOn(PDFPage.prototype,'drawText');
  const result=await buildThermalReceiptPdf({rpc:vi.fn().mockResolvedValue({data:payload,error:null})} as any,
   {type:'pos_receipt',id:'sample'});
  expect((await PDFDocument.load(Buffer.from(result.base64,'base64'))).getPageCount()).toBe(1);
  expect(drawText.mock.calls.map(([value])=>value)).toEqual(expect.arrayContaining([
   '10 Nov 2026 15:00','Generated 10 Nov 2026 15:30',
  ]));
 });
 for(const variant of ['standard','long-labels','wrapped-items','charged-to-room','branded-long','split-tender','menu-qr'])it(variant+' keeps text and rules apart',async()=>{
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
  if (variant === "menu-qr") {
   Object.assign(payload.identity, { brand: { receiptQrDestination: "menu", receiptFeedbackUrl: "https://property.example/menu" } });
  }
  if(variant==='branded-long') {
   Object.assign(payload.identity,{brand:{logoLight:'data:image/png;base64,'+NEO_SYMBOL_BASE64,
    receiptFeedbackUrl:'https://property.example/feedback', receiptPaybill:'123456',receiptPaybillAccount:'ORDER',
    receiptTill:'654321',receiptBankName:'Sample Bank',receiptBankAccountNumber:'0000200000',
    receiptHeaderNote:'Terrace Restaurant',receiptFooterNote:'Thanks for visiting the terrace.',
    receiptPaymentInstructions:'Use the amount shown on this receipt.'}});
   Object.assign(payload.meta,{Table:'Terrace 7',Waiter:'Sample waiter','Collected by':'Sample cashier','Checked by':'Sample manager'});
   payload.lines=Array.from({length:42},(_,index)=>({description:`Lunch item ${index+1} with a wrapping description`,quantity:1,unit_price:45,total:45}));
   payload.totals=[
    {label:"Net before tax",amount:1601.70},{label:"16% VAT · Included",amount:256.27},
    {label:"2% Catering levy · Included",amount:32.03},{label:"Total",amount:1890,emphasis:true},
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
  if (variant === "menu-qr") expect(texts.map((entry) => entry.text)).toContain("SCAN TO VIEW THE MENU");
  if(variant==='branded-long'){
   const rendered=texts.map(t=>t.text);
   expect(rendered).toContain('SCAN TO LEAVE FEEDBACK');
   expect(rendered).toContain('M-Pesa Paybill:');
   expect(rendered).toContain('M-Pesa Till:');
   expect(rendered).toContain('Bank account:');
   expect(rendered).toContain('0000200000');
   expect(rendered).toContain('Terrace Restaurant');
   expect(rendered).toContain('Thanks for visiting the terrace.');
   expect(rendered).toContain('Table:');
   expect(rendered).toContain('Terrace 7');
   expect(rendered.indexOf('Table:')).toBeLessThan(rendered.indexOf('TAX BREAKDOWN'));
   expect(rendered).toContain('TAX BREAKDOWN');
   expect(rendered.join(' ')).toContain('16% VAT · Included');
   expect(rendered).toContain('Total tax');
   expect(rendered).toContain('KES 288.30');
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
  const drawText = vi.spyOn(PDFPage.prototype, "drawText");
  if (type === "invoice") {
   payload.totals = [
    { label: "VAT 16%", amount: 192, emphasis: false },
    { label: "Catering levy 2%", amount: 24, emphasis: false },
    { label: "Total", amount: 1400, emphasis: true },
   ];
  }
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
  if (type === "invoice") {
   const labels = drawText.mock.calls.map(([label]) => label);
   expect(labels).toEqual(expect.arrayContaining(["TAX BREAKDOWN", "VAT 16%", "Catering levy 2%", "Total tax", "216.00", "1,400.00"]));
   expect(labels.indexOf("Total tax")).toBeLessThan(labels.indexOf("Total"));
  }
  if(process.env['RECEIPT_EVIDENCE_DIR']){mkdirSync(process.env['RECEIPT_EVIDENCE_DIR'],{recursive:true});writeFileSync(process.env['RECEIPT_EVIDENCE_DIR']+'/'+type+'.pdf',bytes);}
 });
});
