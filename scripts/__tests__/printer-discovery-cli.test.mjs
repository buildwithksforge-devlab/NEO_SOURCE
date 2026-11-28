import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runDiscovery} from '../neo-printer-discovery-cli.mjs';
test('token-free CLI dispatches each supported read-only discovery kind',async()=>{
 for(const kind of ['network','windows','usb','bluetooth']){
  let called;const expected={printers:[],notes:['Inventory only']};
  const result=await runDiscovery(kind,async value=>{called=value;return expected});
  assert.equal(called,kind);assert.equal(result,expected);
 }
});
test('invalid discovery kind is rejected before any network/OS operation',async()=>{
 let called=false;
 await assert.rejects(runDiscovery('print',async()=>{called=true}),/read-only discovery/);
 assert.equal(called,false);
});
