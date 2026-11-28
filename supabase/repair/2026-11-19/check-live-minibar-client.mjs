const origin=process.argv[2]??"https://neo-preview.neo-hospitality.workers.dev";
if(!["https://neo-preview.neo-hospitality.workers.dev","https://horizon-prime-os.lovable.app"].includes(origin))throw Error("Use a reviewed application origin");
const get=async path=>{
 const response=await fetch(new URL(path,origin),{signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error(`Public asset unavailable (${response.status})`);
 return response.text();
};
const html=await get("/auth");
const entries=[...new Set(html.match(/\/assets\/[^"'\s<>]+\.js/g)??[])];
let route=null;
for(const entry of entries){
 const text=await get(entry);
 route=text.match(/(?:\.\/|\/assets\/)?_shell\.pms\.minibar-[A-Za-z0-9_-]+\.js/)?.[0];
 if(route)break;
}
if(!route){console.log(JSON.stringify({check:"live-minibar-client",verified:false,reason:"Route not found in public entry graph"}));process.exitCode=2;}
else{
 const routePath=route.replace(/^\.\//,"/assets/");
 const code=await get(routePath.startsWith("/")?routePath:`/assets/${routePath}`);
 let keyed=code.includes("neo_minibar_post_once");
 const dependencies=[...new Set(code.match(/(?:\.\/|\/assets\/)?minibar-[A-Za-z0-9_-]+\.js/g)??[])];
 for(const dependency of dependencies){
  const path=dependency.replace(/^\.\//,"/assets/");
  keyed ||= (await get(path.startsWith("/")?path:`/assets/${path}`)).includes("neo_minibar_post_once");
 }
 console.log(JSON.stringify({check:"live-minibar-client",route:routePath,uses_durable_request_rpc:keyed}));
 if(!keyed)process.exitCode=2;
}
