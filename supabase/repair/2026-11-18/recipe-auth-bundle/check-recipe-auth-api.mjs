// Token-free diagnostics: never sends an email/password or authenticated write.
const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!base || !key) throw new Error("Supply the existing project URL/public key through --env-file. Do not supply a service key.");
const origin = new URL(base).origin;
const auth = await fetch(`${origin}/auth/v1/settings`, {headers:{apikey:key},redirect:"manual",signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify({check:"public-auth-service",status:auth.status,accepted:auth.ok}));
// Invalid empty input and no user JWT: a present routine must reject before any
// write. This checks schema-cache availability only, never staff permissions.
const recipe = await fetch(`${origin}/rest/v1/rpc/neo_recipe_sheet_save`,{
 method:"POST",headers:{apikey:key,"content-type":"application/json"},
 body:JSON.stringify({_recipe:{},_components:[],_attempt:null}),redirect:"manual",signal:AbortSignal.timeout(15000),
});
let code=null;try{const body=await recipe.json();code=typeof body.code==="string"?body.code:null;}catch{}
console.log(JSON.stringify({check:"recipe-schema-cache-anonymous-probe",status:recipe.status,code,
 meaning:code==="PGRST202"?"Atomic recipe save is absent from API schema cache":recipe.status===401||recipe.status===403?"Access denied as expected; inspect authorised SQL preflight for installation details":"Review API response in authorised project; no staff transaction was attempted"}));
if(auth.status===401||code==="PGRST202")process.exitCode=2;
