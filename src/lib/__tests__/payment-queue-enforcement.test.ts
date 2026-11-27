import {describe,it,expect,vi} from "vitest";

import {
  handlePaymentQueueIngress,
  runPaymentQueueRuntime,
} from "../payment-queue-runtime.server";

import {
  generatePaymentQueueKey,
  hashPaymentCallbackToken,
  rotatePaymentQueueKeyRegistry,
} from "../payment-queue-security.server";

import type {
  PaymentQueueEnvelope,
} from "../payment-queue-transport.server";

const token="synthetic_enforcement_token_123456";

const url=
  "https://neo-preview.neo-hospitality.workers.dev"+
  "/api/public/mpesa/callback/"+token;

function request(){

  return new Request(url,{

    method:"POST",

    headers:{
      "Content-Type":"application/json"
    },

    body:JSON.stringify({
      Body:{
        stkCallback:{
          CheckoutRequestID:"synthetic-enforcement",
          ResultCode:0,
        }
      }
    }),

  });

}

async function fixture(){

  const key=await generatePaymentQueueKey();

  const hash=await hashPaymentCallbackToken(token);

  const messages: PaymentQueueEnvelope[]=[];

  const send=vi.fn(
    async(message: PaymentQueueEnvelope)=>{
      messages.push(message);
    }
  );

  const env: Record<string,unknown>={

    NEO_PAYMENT_QUEUE_ENABLED:"true",

    NEO_LOVABLE_BRIDGE_ENABLED:"true",

    NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED:"true",

    NEO_PAYMENT_QUEUE_ACTIVE_KEY:"v1",

    NEO_PAYMENT_QUEUE_KEYS:
      JSON.stringify({v1:key}),

    NEO_PAYMENT_CALLBACK_TOKEN_HASHES:
      JSON.stringify([hash]),

    NEO_PAYMENT_QUEUE:{send},

  };

  return {env,key,hash,messages,send};

}

describe("runtime payment security enforcement",()=>{

  it("accepts valid authenticated transport configuration",async()=>{

    const {env,send}=await fixture();

    const result=await handlePaymentQueueIngress(
      request(),env
    );

    expect(result?.status).toBe(200);

    expect(send).toHaveBeenCalledTimes(1);

  });

  it("rejects duplicate callback token hashes at actual ingress",async()=>{

    const {env,hash,send}=await fixture();

    env["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"]=
      JSON.stringify([hash,hash]);

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(503);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects invalid historical encryption keys",async()=>{

    const {env,key,send}=await fixture();

    env["NEO_PAYMENT_QUEUE_KEYS"]=
      JSON.stringify({
        v1:key,
        invalid:btoa("invalid")
      });

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(503);

    expect(send).not.toHaveBeenCalled();

  });

  it("rejects duplicate encryption material",async()=>{

    const {env,key,send}=await fixture();

    env["NEO_PAYMENT_QUEUE_KEYS"]=
      JSON.stringify({v1:key,v2:key});

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(503);

    expect(send).not.toHaveBeenCalled();

  });

  it("invalidates cached readiness after configuration changes",async()=>{

    const {env,hash,send}=await fixture();

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(200);

    env["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"]=
      JSON.stringify([hash,hash]);

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(503);

    expect(send).toHaveBeenCalledTimes(1);

  });

  it("does not reuse readiness for an unavailable producer",async()=>{

    const {env}=await fixture();

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(200);

    delete env["NEO_PAYMENT_QUEUE"];

    expect(
      (await handlePaymentQueueIngress(
        request(),env
      ))?.status
    ).toBe(503);

  });

  it("preserves queued evidence across active key rotation",async()=>{

    const {env,key,messages}=await fixture();

    await handlePaymentQueueIngress(request(),env);

    const rotated=
      await rotatePaymentQueueKeyRegistry(
        {v1:key},
        "v2"
      );

    env["NEO_PAYMENT_QUEUE_KEYS"]=
      JSON.stringify(rotated.keys);

    env["NEO_PAYMENT_QUEUE_ACTIVE_KEY"]=
      rotated.activeKeyId;

    await handlePaymentQueueIngress(request(),env);

    expect(messages).toHaveLength(2);

    const items=messages.map(body=>({

      body,

      attempts:1,

      ack:vi.fn(),

      retry:vi.fn(),

    }));

    const result=await runPaymentQueueRuntime(

      {messages:items},

      env,

      async()=>Response.json({ResultCode:0}),

    );

    expect(result.completed).toBe(2);

    expect(result.unresolved).toBe(0);

    for(const item of items){

      expect(item.ack).toHaveBeenCalledTimes(1);

      expect(item.retry).not.toHaveBeenCalled();

    }

  });

  it("rejects duplicate historical material during rotation",async()=>{

    const {key}=await fixture();

    await expect(

      rotatePaymentQueueKeyRegistry(
        {v1:key,v2:key},
        "v3"
      ),

    ).rejects.toThrow(
      "duplicate-existing-payment-key-material"
    );

  });

  it("does not reuse a cached key after its registry entry is removed",async()=>{

    const {env,messages}=await fixture();

    await handlePaymentQueueIngress(request(),env);

    env["NEO_PAYMENT_QUEUE_KEYS"]="{}";

    const item={

      body:messages[0],

      attempts:1,

      ack:vi.fn(),

      retry:vi.fn(),

    };

    const upstream=vi.fn(
      async()=>Response.json({ResultCode:0})
    );

    const result=await runPaymentQueueRuntime(

      {messages:[item]},

      env,

      upstream,

    );

    expect(result.retried).toBe(1);

    expect(item.ack).not.toHaveBeenCalled();

    expect(upstream).not.toHaveBeenCalled();

  });

  it("does not intercept application traffic while disabled",async()=>{

    const {env,send}=await fixture();

    env["NEO_PAYMENT_QUEUE_ENABLED"]="false";

    expect(
      await handlePaymentQueueIngress(
        request(),env
      )
    ).toBeNull();

    expect(send).not.toHaveBeenCalled();

  });

});