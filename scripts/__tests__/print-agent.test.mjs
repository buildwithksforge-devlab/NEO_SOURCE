import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once, EventEmitter } from "node:events";
import { processPrinter, finish } from "../neo-print-agent.mjs";
import {
  decodePrinterDns,
  printerDnsQuery,
  discoverPrinters,
  discoverNetwork,
  windowsInventory,
  probeTcp,
} from "../neo-printer-discovery.mjs";

const jobId = "00000000-0000-0000-0000-000000000001",
  claimId = "00000000-0000-0000-0000-000000000002";
const config = {
  apiBase: "https://owned-neo.test/api/public/print-agent",
  token: "neopc_" + "a".repeat(64),
};
async function withFetch(callback, run) {
  const original = globalThis.fetch;
  globalThis.fetch = callback;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}
function mockApi(job, { failFinish = false } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body, authorization: options.headers.authorization });
      return Response.json(
        url.endsWith("/claim")
          ? { job }
          : failFinish
            ? { error: "acknowledgement_failed" }
            : { status: { status: "completed" } },
        { status: failFinish && url.endsWith("/finish") ? 503 : 200 },
      );
    },
  };
}
async function tcpFixture(run) {
  const chunks = [];
  let received;
  const complete = new Promise((resolve) => {
    received = resolve;
  });
  const server = createServer((socket) => {
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      socket.end();
      received();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`127.0.0.1:${server.address().port}`, chunks, complete);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("agent writes actual ESC/POS bytes over local TCP then acknowledges the same claim_id", async () => {
  await tcpFixture(async (address, chunks, received) => {
    const api = mockApi({
      job_id: jobId,
      claim_id: claimId,
      title: "NEO CONTROLLED TEST",
      document_type: "test",
      payload: {},
      printer: { connection_type: "network", address },
    });
    await withFetch(api.fetch, async () =>
      assert.equal(
        await processPrinter(config, { id: "printer-1", name: "Loopback fixture" }),
        true,
      ),
    );
    assert.equal(api.calls.length, 2);
    assert.deepEqual(api.calls[1].body, {
      job_id: jobId,
      claim_id: claimId,
      outcome: "completed",
      error: null,
    });
    assert.equal(api.calls[0].authorization, `Bearer ${config.token}`);
    await received;
    const bytes = Buffer.concat(chunks);
    assert.ok(bytes.length > 10);
    assert.ok(bytes.includes(Buffer.from("NEO CONTROLLED TEST")));
    assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0])));
  });
});
test("lost completion acknowledgement surfaces as an error without a second physical send", async () => {
  await tcpFixture(async (address) => {
    const api = mockApi(
      {
        job_id: jobId,
        claim_id: claimId,
        title: "TEST",
        payload: {},
        printer: { connection_type: "network", address },
      },
      { failFinish: true },
    );
    await withFetch(api.fetch, async () =>
      assert.rejects(
        processPrinter(config, { id: "printer-1", name: "fixture" }),
        /acknowledgement_failed/,
      ),
    );
    assert.deepEqual(
      api.calls.map((call) => call.url.split("/").pop()),
      ["claim", "finish"],
    );
  });
});
test("unsupported connection is reported as not_printed and never as completed", async () => {
  const api = mockApi({
    job_id: jobId,
    claim_id: claimId,
    printer: { connection_type: "unknown" },
  });
  await withFetch(api.fetch, async () =>
    assert.equal(await processPrinter(config, { id: "printer-1", name: "fixture" }), true),
  );
  assert.equal(api.calls[1].body.outcome, "not_printed");
});
test("empty queue causes no write or completion call", async () => {
  const api = mockApi(null);
  await withFetch(api.fetch, async () =>
    assert.equal(await processPrinter(config, { id: "printer-1" }), false),
  );
  assert.equal(api.calls.length, 1);
});
test("finish preserves the exact SQL/API claim identity and explicit unknown outcome", async () => {
  const api = mockApi(null);
  await withFetch(api.fetch, () =>
    finish(config, { job_id: jobId, claim_id: claimId }, "outcome_unknown", "write interrupted"),
  );
  assert.equal(api.calls[0].body.claim_id, claimId);
  assert.equal(api.calls[0].body.outcome, "outcome_unknown");
  assert.ok(!("claim_token" in api.calls[0].body));
});
function name(value) {
  return Buffer.concat([
    ...value
      .split(".")
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
}
function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}
function advertisement() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(4, 6);
  const srv = (port) => {
    const data = Buffer.alloc(6);
    data.writeUInt16BE(port, 4);
    return Buffer.concat([data, name("thermal.local")]);
  };
  return Buffer.concat([
    header,
    record("Thermal._pdl-datastream._tcp.local", 33, srv(9100)),
    record("Office._ipp._tcp.local", 33, srv(631)),
    record("thermal.local", 1, Buffer.from([192, 168, 1, 50])),
    record("ignored.local", 16, Buffer.from([0])),
  ]);
}
test("DNS parser reads real SRV/A records and ignores unrelated advertisements", () => {
  const records = decodePrinterDns(advertisement());
  assert.equal(records.length, 3);
  assert.equal(records[0].port, 9100);
  assert.equal(records[2].address, "192.168.1.50");
  assert.equal(printerDnsQuery().readUInt16BE(4), 3);
});
test("DNS parser refuses pointer cycles, truncated packets and excessive record counts", () => {
  assert.deepEqual(decodePrinterDns(Buffer.alloc(1)), []);
  const packet = Buffer.alloc(24);
  packet.writeUInt16BE(0x8400, 2);
  packet.writeUInt16BE(1, 6);
  packet[12] = 0xc0;
  packet[13] = 12;
  assert.throws(() => decodePrinterDns(packet), /pointer cycle/);
  const big = Buffer.alloc(12);
  big.writeUInt16BE(0x8400, 2);
  big.writeUInt16BE(513, 6);
  assert.throws(() => decodePrinterDns(big), /Oversized/);
  assert.throws(
    () => decodePrinterDns(advertisement().subarray(0, 18)),
    /Truncated|Invalid DNS label/,
  );
});
test("network search sends an actual local mDNS query and distinguishes RAW from unsupported IPP", async () => {
  let query;
  class Socket extends EventEmitter {
    bind(port, callback) {
      assert.equal(port, 0);
      callback();
    }
    send(bytes, port, host, callback) {
      query = { bytes, port, host };
      this.emit("message", advertisement());
      callback();
    }
    close() {}
  }
  const result = await discoverNetwork({ duration: 10, socketFactory: () => new Socket() });
  assert.equal(query.host, "224.0.0.251");
  assert.equal(query.port, 5353);
  assert.equal(result.printers.length, 2);
  assert.equal(result.printers[0].connection_type, "network");
  assert.equal(result.printers[1].connection_type, "unsupported");
});
test("discovery merges installed queues with network results without inventing physical proof", async () => {
  let searched;
  const result = await discoverPrinters("network", {
    os: "win32",
    inventory: async (kind) => {
      searched = kind;
      return { printers: [{ name: "Installed queue" }], notes: ["installed only"] };
    },
    network: async () => ({
      printers: [{ name: "Advertised printer" }],
      notes: ["advertised only"],
    }),
  });
  assert.equal(searched, "network");
  assert.equal(result.printers.length, 2);
  assert.deepEqual(result.notes, ["installed only", "advertised only"]);
});

test("network discovery resolves a PTR-only printer reply through separate SRV and address replies", async () => {
  const name = value => Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
  const packet = (owner, type, data) => {
    const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(1, 6);
    const rr = Buffer.alloc(10); rr.writeUInt16BE(type); rr.writeUInt16BE(1, 2); rr.writeUInt32BE(120, 4); rr.writeUInt16BE(data.length, 8);
    return Buffer.concat([header, name(owner), rr, data]);
  };
  let sends = 0;
  class Socket extends EventEmitter {
    bind(_port, callback) { callback(); }
    close() {}
    send(bytes, port, host, callback) {
      assert.equal(port, 5353); assert.equal(host, '224.0.0.251'); sends++;
      if (sends === 1) this.emit('message', packet('_pdl-datastream._tcp.local', 12, name('Thermal._pdl-datastream._tcp.local')));
      else if (sends === 2) {
        assert.equal(bytes.readUInt16BE(bytes.length - 4), 33);
        const srv = Buffer.alloc(6); srv.writeUInt16BE(9100, 4);
        this.emit('message', packet('Thermal._pdl-datastream._tcp.local', 33, Buffer.concat([srv, name('thermal.local')])));
      } else if (sends === 3) {
        assert.equal(bytes.readUInt16BE(bytes.length - 4), 1);
        const response = packet('thermal.local', 1, Buffer.from([192,168,1,52]));
        this.emit('message', response); this.emit('message', response);
      } else assert.fail('Repeated replies must not cause a query loop');
      callback();
    }
  }
  const result = await discoverNetwork({duration: 10, socketFactory: () => new Socket()});
  assert.equal(sends, 3);
  assert.equal(result.printers.length, 1);
  assert.equal(result.printers[0].address, '192.168.1.52:9100');
});
test("Bluetooth queue search calls the native inventory adapter and does not pretend to pair devices", async () => {
  let searched;
  const result = await discoverPrinters("bluetooth", {
    os: "win32",
    inventory: async (kind) => {
      searched = kind;
      return { printers: [], notes: ["Pair in Windows first"] };
    },
    network: async () => {
      throw Error("Unexpected network scan");
    },
  });
  assert.equal(searched, "bluetooth");
  assert.equal(result.printers.length, 0);
  assert.match(result.notes[0], /Pair in Windows/);
});
test("unavailable native inventory reports its failure without making up printers", async () => {
  const result = await discoverPrinters("usb", {
    os: "win32",
    inventory: async () => {
      throw Error("Spooler unavailable");
    },
  });
  assert.deepEqual(result.printers, []);
  assert.deepEqual(result.notes, ["Spooler unavailable"]);
  const unsupported = await discoverPrinters("bluetooth", { os: "linux" });
  assert.equal(unsupported.printers.length, 0);
  assert.match(unsupported.notes[0], /requires a Windows/);
});
test("native inventory is invoked with a fixed script and validated transport argument", async () => {
  let invocation;
  const result = await windowsInventory("usb", {
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ printers: [], notes: [] }));
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.args.slice(-2), ["-Kind", "usb"]);
  assert.deepEqual(result.printers, []);
});
test("TCP connectivity probe connects without sending any print bytes", async () => {
  await tcpFixture(async (address, chunks) => {
    const result = await probeTcp(address);
    assert.equal(result.reachable, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Buffer.concat(chunks).length, 0);
    assert.match(result.proof, /no print bytes/);
  });
  await assert.rejects(probeTcp("printer:99999"), /Invalid TCP port/);
});

test(
  "native PowerShell inventory adapter filters real-shaped queues and excludes virtual output",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./printer-inventory.test.ps1", import.meta.url)),
      ],
      { windowsHide: true, timeout: 15000 },
    );
    assert.match(stdout, /PASS native inventory adapter/);
  },
);
