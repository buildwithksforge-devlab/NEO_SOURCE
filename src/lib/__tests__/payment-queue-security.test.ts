import {describe,it,expect} from "vitest";

import {
  generatePaymentQueueKey,
  hashPaymentCallbackToken,
  validatePaymentQueueConfiguration,
  rotatePaymentQueueKeyRegistry,
} from "../payment-queue-security.server";

import {
  importPaymentQueueKey,
  sealPaymentQueueEvidence,
  openPaymentQueueEvidence,
} from "../payment-queue-transport.server";

async function fixture() {

  const key = await generatePaymentQueueKey();

  const hash = await hashPaymentCallbackToken(
    "synthetic_security_token_123456",
  );

  const runtime: Record<string,unknown> = {

    NEO_LOVABLE_BRIDGE_ENABLED:"true",

    NEO_LOVABLE_BRIDGE_CALLBACKS_ENABLED:"true",

    NEO_PAYMENT_QUEUE:{
      async send(){}
    },

    NEO_PAYMENT_QUEUE_ACTIVE_KEY:"v1",

    NEO_PAYMENT_QUEUE_KEYS:
      JSON.stringify({v1:key}),

    NEO_PAYMENT_CALLBACK_TOKEN_HASHES:
      JSON.stringify([hash]),

  };

  return {runtime,key,hash};

}

describe("payment queue security readiness",()=>{

  it("generates cryptographically random 256-bit keys",async()=>{

    const first=await generatePaymentQueueKey();

    const second=await generatePaymentQueueKey();

    expect(atob(first)).toHaveLength(32);

    expect(first).not.toBe(second);

  });

  it("hashes callback tokens without returning plaintext",async()=>{

    const token="synthetic_security_token_123456";

    const digest=await hashPaymentCallbackToken(token);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    expect(digest).not.toContain(token);

    expect(
      await hashPaymentCallbackToken(token)
    ).toBe(digest);

  });

  it("rejects malformed callback tokens",async()=>{

    await expect(
      hashPaymentCallbackToken("short")
    ).rejects.toThrow("invalid-callback-token");

  });

  it("recognizes complete transport configuration",async()=>{

    const {runtime}=await fixture();

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(true);

    expect(result.activeKeyAvailable).toBe(true);

    expect(result.registeredKeys).toBe(1);

    expect(result.registeredTokens).toBe(1);

  });

  it("does not confuse transport readiness with activation authority",async()=>{

    const {runtime}=await fixture();

    runtime["NEO_PAYMENT_QUEUE_ENABLED"]="true";

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(true);

    expect(result.activationAllowed).toBe(false);

    expect(result.blockers).toContain(
      "managed-financial-verification-required"
    );

  });

  it("rejects missing queue bindings",async()=>{

    const {runtime}=await fixture();

    delete runtime["NEO_PAYMENT_QUEUE"];

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

    expect(result.blockers).toContain(
      "payment-producer-unavailable"
    );

  });

  it("rejects missing managed backend authority",async()=>{

    const {runtime}=await fixture();

    runtime["NEO_LOVABLE_BRIDGE_ENABLED"]="false";

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

  });

  it("rejects missing token registry",async()=>{

    const {runtime}=await fixture();

    delete runtime["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"];

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

  });

  it("rejects duplicate callback registrations",async()=>{

    const {runtime,hash}=await fixture();

    runtime["NEO_PAYMENT_CALLBACK_TOKEN_HASHES"]=
      JSON.stringify([hash,hash]);

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

  });

  it("rejects missing active encryption keys",async()=>{

    const {runtime}=await fixture();

    runtime["NEO_PAYMENT_QUEUE_ACTIVE_KEY"]="missing";

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.activeKeyAvailable).toBe(false);

    expect(result.transportReady).toBe(false);

  });

  it("rejects invalid encryption key material",async()=>{

    const {runtime}=await fixture();

    runtime["NEO_PAYMENT_QUEUE_KEYS"]=
      JSON.stringify({v1:btoa("invalid")});

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

  });

  it("rejects duplicate encryption key material",async()=>{

    const {runtime,key}=await fixture();

    runtime["NEO_PAYMENT_QUEUE_KEYS"]=
      JSON.stringify({v1:key,v2:key});

    const result=
      await validatePaymentQueueConfiguration(runtime);

    expect(result.transportReady).toBe(false);

  });

  it("retains earlier encryption keys during rotation",async()=>{

    const {key}=await fixture();

    const rotated=await rotatePaymentQueueKeyRegistry(
      {v1:key},
      "v2"
    );

    expect(rotated.activeKeyId).toBe("v2");

    expect(rotated.keys["v1"]).toBe(key);

    expect(rotated.keys["v2"]).not.toBe(key);

  });

  it("decrypts evidence created before key rotation",async()=>{

    const {key}=await fixture();

    const evidence={

      path:"/api/public/mpesa/callback/synthetic_rotation_token_1234",

      body:JSON.stringify({
        Body:{
          stkCallback:{
            CheckoutRequestID:"synthetic-rotation",
            ResultCode:0,
          }
        }
      }),

    };

    const envelope=await sealPaymentQueueEvidence(

      evidence,

      "v1",

      await importPaymentQueueKey(key),

    );

    const rotated=await rotatePaymentQueueKeyRegistry(

      {v1:key},

      "v2",

    );

    const recovered=await openPaymentQueueEvidence(

      envelope,

      async id=>{

        const encoded=rotated.keys[id];

        if(!encoded) throw new Error("missing-key");

        return importPaymentQueueKey(encoded);

      },

    );

    expect(recovered).toEqual(evidence);

  });

  it("does not overwrite existing encryption key identifiers",async()=>{

    const {key}=await fixture();

    await expect(

      rotatePaymentQueueKeyRegistry(
        {v1:key},
        "v1"
      ),

    ).rejects.toThrow(
      "payment-key-id-already-exists"
    );

  });

  it("does not expose credentials through readiness results",async()=>{

    const {runtime,key,hash}=await fixture();

    const result=
      await validatePaymentQueueConfiguration(runtime);

    const serialized=JSON.stringify(result);

    expect(serialized).not.toContain(key);

    expect(serialized).not.toContain(hash);

  });

});