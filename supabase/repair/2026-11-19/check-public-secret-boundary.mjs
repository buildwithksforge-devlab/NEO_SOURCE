import {existsSync,readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
if(existsSync(".env.local"))process.loadEnvFile(".env.local");
const names=["SUPABASE_SERVICE_ROLE_KEY","LOVABLE_API_KEY","OPENAI_API_KEY","RESEND_API_KEY","AT_API_KEY","WHATSAPP_TOKEN","WEB_PUSH_VAPID_PRIVATE_KEY","NEO_PUSH_DISPATCH_TOKEN"];
const project=new URL(process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL).hostname.split(".")[0];
const publicValues=new Set([project,process.env.SUPABASE_PUBLISHABLE_KEY,process.env.VITE_SUPABASE_PUBLISHABLE_KEY]);
const keys=names.map(name=>({name,value:process.env[name]})).filter(k=>k.value&&k.value.length>=16&&!publicValues.has(k.value));
const files=[];const walk=path=>{for(const entry of readdirSync(path,{withFileTypes:true})){
 const full=join(path,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())files.push(full);
}};walk(".output/public");
const hits=[];for(const file of files){const bytes=readFileSync(file);for(const key of keys)if(bytes.includes(Buffer.from(key.value)))hits.push({file,key:key.name});}
if(hits.length){console.error(JSON.stringify({passed:false,hits}));process.exitCode=1;}
else console.log(JSON.stringify({passed:true,public_files_scanned:files.length,local_server_credentials_checked:keys.map(k=>k.name),service_setting_is_public_project_identifier:process.env.SUPABASE_SERVICE_ROLE_KEY===project}));
