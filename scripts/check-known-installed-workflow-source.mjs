import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
const read=path=>readFileSync(path,"utf8").replaceAll("\r\n","\n");
const md5=value=>createHash("md5").update(value).digest("hex");
const source=read("supabase/migrations/20261116110000_mpesa_receipt_review.sql");
const start=source.lastIndexOf("CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(");
const end=source.indexOf("END $function$;",start);
if(start<0||end<0)throw Error("Reviewed payment source missing");
const payment=source.slice(start,end+"END $function$;".length);
const db=new PGlite();
try{
 await db.exec("CREATE TABLE pos_orders(id uuid);CREATE TABLE pos_payments(id uuid);CREATE TABLE pos_shifts(id uuid)");
 await db.exec(payment);
 const row=(await db.query("SELECT md5(pg_get_functiondef('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)'::regprocedure)) hash")).rows[0];
 console.log(JSON.stringify({check:"reviewed-mpesa-payment-definition",hash:row.hash,matches_user_installed_hash:row.hash==="915008ca2eb86bd57147bb54230b7817"}));
}finally{await db.close();}
const matches=[];
for(const name of readdirSync("supabase/migrations").filter(n=>n.endsWith(".sql"))){
 const text=read(`supabase/migrations/${name}`);
 const at=text.indexOf("CREATE OR REPLACE FUNCTION public.neo_minibar_post(");
 if(at<0)continue;
 const body=text.slice(at).match(/AS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/);
 if(!body)continue;
 const hash=md5(body[2].replace(/--[^\n]*/g,"").replace(/\s/g,""));
 if(hash==="02e573b16d42f6eadb1a8fbc3ee9c80a")matches.push(name);
}
console.log(JSON.stringify({check:"live-minibar-source-candidate",matching_source_files:matches,meaning:matches.length?"Compare this known source with staged guards":"Installed body is not among the extracted reviewed candidates; preserve and inspect it"}));
const minibarSource=read("supabase/migrations/20260924153000_front_office_connected_guards.sql").match(/CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/)[0];
const variant=minibarSource.replace("public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id)","public.neo_stock_resolve_location(v_folio.organization_id, v_comp.item_id, v_folio.branch_id, NULL)");
const liveVariant=variant.replace(/^\s*PERFORM set_config\('neo\.system_posting', '(?:on|off)', true\);\s*$/gm, "");
console.log(JSON.stringify({check:"minibar-location-variant",original:md5(minibarSource.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")),variant:md5(liveVariant.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,""))}));
