import { describe,it,expect } from "vitest";

import { readFileSync } from "node:fs";

const server=readFileSync(
  "src/server.ts","utf8"
);

const deploy=readFileSync(
  "scripts/deploy-neo-preview.ps1","utf8"
);

const installer=readFileSync(
  "scripts/connect-payment-worker.mjs","utf8"
);

describe("protected payment Worker integration",()=>{

  it("exposes an internal application event dispatcher",()=>{

    expect(server).toContain(
      "export const neoPaymentWorkerEvents"
    );

    expect(server).toContain(
      "return handleWorkerPaymentQueue"
    );

  });

  it("retains the existing HTTP payment ingress",()=>{

    expect(server).toContain(
      "NEO_PAYMENT_WORKER_INGRESS_V1"
    );

    expect(server).toContain(
      "forwardManagedMpesaCallback"
    );

  });

  it("requires an actual generated dispatcher export",()=>{

    expect(installer).toContain(
      "Expected one exported payment dispatcher"
    );

  });

  it("keeps the dead-letter queue without a consumer",()=>{

    expect(installer).toContain(
      "Dead-letter queue must not have an automatic consumer"
    );

  });

  it("bounds total configured payment forwarding",()=>{

    expect(installer).toContain(
      "max_concurrency:5"
    );

    expect(installer).toContain(
      "max_batch_size:20"
    );

  });

  it("keeps payment ingress disabled in prepared builds",()=>{

    expect(installer).toContain(
      'NEO_PAYMENT_QUEUE_ENABLED:"false"'
    );

    expect(installer).toContain(
      'NEO_PAYMENT_QUEUE_DRAIN_ENABLED:"false"'
    );

  });

  it("connects generated handlers before artifact preparation",()=>{

    const integration=deploy.indexOf(
      "NEO_PAYMENT_QUEUE_PROTECTED_BUILD_V1"
    );

    const prepare=deploy.indexOf(
      "scripts/release-artifact-guard.mjs' -Arguments @('prepare')"
    );

    expect(integration).toBeGreaterThanOrEqual(0);

    expect(prepare).toBeGreaterThan(integration);

  });

  it("blocks unverified live infrastructure rollout",()=>{

    expect(deploy).toContain(
      "NEO_PAYMENT_INFRASTRUCTURE_RELEASE_GATE_V1"
    );

    expect(deploy).toContain(
      "live deployment blocked"
    );

  });

});