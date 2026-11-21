// Read-only availability checks. Never prints tokens, provider payloads or users.
const deadline=()=>AbortSignal.timeout(15000);
for(const origin of ["https://neo-preview.neo-hospitality.workers.dev","https://horizon-prime-os.lovable.app"]){
 try{
  const response=await fetch(`${origin}/auth`,{redirect:"manual",signal:deadline()});
  const html=await response.text();
  const build=html.match(/name="neo-build-id"\s+content="([a-f0-9]{16})"/)?.[1]??null;
  console.log(JSON.stringify({check:"public-auth-page",origin,status:response.status,build}));
 }catch{console.log(JSON.stringify({check:"public-auth-page",origin,result:"unreachable"}));process.exitCode=2;}
}
const base=process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL;
const publicKey=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(base&&publicKey&&serviceKey){
 const expected=readProjectRef();
 if(new URL(base).origin!==`https://${expected}.supabase.co`)throw Error("Project URL differs from the reviewed checkout; stop before sending credentials");
 try{
  const response=await fetch(`${new URL(base).origin}/rest/v1/provider_connections?select=id&limit=0`,{
   headers:{apikey:publicKey,authorization:`Bearer ${serviceKey}`},redirect:"manual",signal:deadline(),
  });
  let code=null;try{const result=await response.json();code=typeof result.code==="string"?result.code:null;}catch{}
  console.log(JSON.stringify({check:"local-privileged-runtime-read-zero-rows",status:response.status,code}));
 }catch{console.log(JSON.stringify({check:"local-privileged-runtime-read-zero-rows",result:"unreachable"}));process.exitCode=2;}
}else console.log(JSON.stringify({check:"local-privileged-runtime-read-zero-rows",result:"credentials-unavailable"}));
function readProjectRef(){
 return readFileSync("supabase/config.toml","utf8").match(/^project_id\s*=\s*"([a-z0-9]+)"/m)?.[1]??"";
}
import {readFileSync} from "node:fs";
