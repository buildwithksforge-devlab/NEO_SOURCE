import {existsSync} from "node:fs";
if(existsSync(".env.local"))process.loadEnvFile(".env.local");
const base=process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL;
const key=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!base||!key)throw Error("Public project configuration is missing");
const origin=new URL(base).origin;
const headers={apikey:key,"content-type":"application/json"};
const auth=await fetch(`${origin}/auth/v1/settings`,{headers,redirect:"manual",signal:AbortSignal.timeout(15000)});
if(!auth.ok)throw Error("Project Auth/public API is unavailable; do not deploy");
const transferColumn=await fetch(`${origin}/rest/v1/pos_orders?select=room_transfer_paid_total&limit=0`,{
 method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(15000),
});
const transferCode=transferColumn.ok?null:(await transferColumn.json().catch(()=>null))?.code??null;
console.log(JSON.stringify({column:"pos_orders.room_transfer_paid_total",status:transferColumn.status,code:transferCode}));
if(!transferColumn.ok&&(![401,403].includes(transferColumn.status)||transferCode!=="42501")){
 throw Error("Required POS room transfer column installation check failed; do not deploy the matching client");
}
const uuid="00000000-0000-4000-8000-000000000000";
const deliveryWorkspace=await fetch(`${origin}/rest/v1/rpc/neo_public_delivery_workspace`,{method:"POST",headers,body:JSON.stringify({_slug:""}),redirect:"manual",signal:AbortSignal.timeout(15000)});
if(!deliveryWorkspace.ok||(await deliveryWorkspace.json())!==null)throw Error("Public Delivery publication routine installation check failed");
for(const [name,body] of [
 ["neo_recipe_sheet_save",{_recipe:{},_components:[],_attempt:null}],
 ["neo_minibar_post_once",{_folio:uuid,_location:uuid,_lines:[],_room:null,_notes:null,_attempt:null}],
 ["neo_platform_run_checks",{_branch:uuid}],
 ["neo_platform_public_app_targets",{_branch:uuid}],
 ["neo_pos_department_menu_availability",{_branch:uuid,_channel:"delivery"}],
 ["neo_guest_active_stay",{_org:uuid,_branch:uuid}],
 ["neo_guest_my_stays",{_org:uuid,_branch:uuid}],
 ["neo_guest_verify_stay",{_org:uuid,_branch:uuid,_reference:"",_detail:""}],
 ["neo_guest_create_request",{_org:uuid,_branch:uuid,_category:"concierge",_description:"",_priority:"normal"}],
 ["neo_guest_request_transport",{_org:uuid,_branch:uuid,_product:null,_pickup_at:null,_pickup_point:"",_destination:"",_passengers:1,_luggage:0,_travel_reference:null,_notes:null}],
 ["neo_guest_folio_projection",{_org:uuid,_branch:uuid}],
]){
 const result=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:"POST",headers,body:JSON.stringify(body),redirect:"manual",signal:AbortSignal.timeout(15000)});
 let code=null;try{code=(await result.json()).code??null;}catch{}
 console.log(JSON.stringify({routine:name,status:result.status,code}));
 if(![401,403].includes(result.status)||code!=="42501")throw Error(`Required ${name} installation/permission check failed; do not deploy the matching client`);
}
