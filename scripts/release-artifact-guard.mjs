import {readFileSync,writeFileSync,readdirSync} from "node:fs";
import {join,relative} from "node:path";
import {createHash} from "node:crypto";
import {sourceFingerprint} from "./build-identity.ts";
const action=process.argv[2],root=process.cwd();
const statePath=join(root,".output/neo-release-prepared.json");
function artifactHash(){
 const files=[];
 const walk=path=>{for(const entry of readdirSync(path,{withFileTypes:true})){
  const full=join(path,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())files.push(full);
 }};
 walk(join(root,".output/server"));walk(join(root,".output/public"));
 const hash=createHash("sha256");
 for(const file of files.sort()){hash.update(relative(root,file));hash.update("\0");hash.update(readFileSync(file));hash.update("\0");}
 return hash.digest("hex");
}
if(action==="fingerprint") console.log(sourceFingerprint(root));
else if(action==="prepare"){
 const state={source:sourceFingerprint(root),artifact:artifactHash(),target:"https://neo-preview.neo-hospitality.workers.dev"};
 writeFileSync(statePath,JSON.stringify(state,null,2));console.log(JSON.stringify({prepared:true,source:state.source}));
}else if(action==="verify"){
 const state=JSON.parse(readFileSync(statePath,"utf8"));
 if(state.source!==sourceFingerprint(root)||state.artifact!==artifactHash())throw Error("Source or built artifact changed after preparation; rebuild before deploying");
 console.log(JSON.stringify({verified:true,source:state.source}));
}else throw Error("Choose fingerprint, prepare or verify");
