import {existsSync} from "node:fs";
if(existsSync(".env.local"))process.loadEnvFile(".env.local");
const base=process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL;
const key=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!base||!key)throw Error("Public project configuration is missing");
const origin=new URL(base).origin;
const headers={apikey:key,"content-type":"application/json"};
const auth=await fetch(`${origin}/auth/v1/settings`,{headers,redirect:"manual",signal:AbortSignal.timeout(15000)});
if(!auth.ok)throw Error("Project Auth/public API is unavailable; do not deploy");
const uuid="00000000-0000-4000-8000-000000000000";
for(const [name,body] of [
 ["neo_recipe_sheet_save",{_recipe:{},_components:[],_attempt:null}],
 ["neo_minibar_post_once",{_folio:uuid,_location:uuid,_lines:[],_room:null,_notes:null,_attempt:null}],
 ["neo_platform_run_checks",{_branch:uuid}],
]){
 const result=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:"POST",headers,body:JSON.stringify(body),redirect:"manual",signal:AbortSignal.timeout(15000)});
 let code=null;try{code=(await result.json()).code??null;}catch{}
 console.log(JSON.stringify({routine:name,status:result.status,code}));
 if(![401,403].includes(result.status)||code!=="42501")throw Error(`Required ${name} installation/permission check failed; do not deploy the matching client`);
}
