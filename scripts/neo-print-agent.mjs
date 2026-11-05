#!/usr/bin/env node

import {
  readFile,
  writeFile,
  unlink,
} from "node:fs/promises";
import { createConnection } from "node:net";
import {
  hostname,
  platform,
  tmpdir,
} from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

const scriptDirectory = dirname(
  fileURLToPath(import.meta.url),
);

const configPath = resolve(
  process.argv[2]
    ?? process.env.NEO_PRINT_AGENT_CONFIG
    ?? "neo-print-agent.json",
);

const sleep = (milliseconds) =>
  new Promise((done) =>
    setTimeout(done, milliseconds),
  );

function fail(message) {
  throw new Error(message);
}

async function loadConfig() {
  let source;

  try {
    source = await readFile(configPath, "utf8");
  } catch {
    fail(`Configuration not found: ${configPath}`);
  }

  let input;

  try {
    input = JSON.parse(source);
  } catch {
    fail(`Configuration is not valid JSON: ${configPath}`);
  }

  const apiBase = String(input.apiBase ?? "")
    .trim()
    .replace(/\/+$/, "");

  const token = String(input.token ?? "").trim();

  if (
    !apiBase.startsWith("https://")
    && !apiBase.startsWith("http://localhost")
    && !apiBase.startsWith("http://127.0.0.1")
  ) {
    fail("apiBase must use HTTPS outside localhost");
  }

  if (!/^neopc_[0-9a-f]{64}$/.test(token)) {
    fail(
      "token must be neopc_ followed by 64 lowercase hexadecimal characters",
    );
  }

  const pollMilliseconds = Number(
    input.pollMilliseconds ?? 2500,
  );

  if (
    !Number.isFinite(pollMilliseconds)
    || pollMilliseconds < 1000
    || pollMilliseconds > 60000
  ) {
    fail(
      "pollMilliseconds must be between 1000 and 60000",
    );
  }

  const configuredIds =
    Array.isArray(input.printerIds)
    && input.printerIds.length > 0
      ? new Set(input.printerIds.map(String))
      : null;

  return {
    apiBase,
    token,
    pollMilliseconds,
    refreshMilliseconds: Math.max(
      15000,
      Number(
        input.refreshPrintersMilliseconds
        ?? 60000,
      ),
    ),
    printerIds: configuredIds,
  };
}

async function callApi(config, action, body = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    20000,
  );

  try {
    const response = await fetch(
      `${config.apiBase}/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    const text = await response.text();
    let payload = {};

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        fail(
          `NEO returned non-JSON data for ${action}`,
        );
      }
    }

    if (!response.ok) {
      fail(
        String(
          payload.error
          ?? payload.message
          ?? `HTTP ${response.status}`,
        ),
      );
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function ascii(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\r/g, "");
}

function wrap(value, width = 42) {
  let remaining = ascii(value).trim();

  if (!remaining) {
    return [""];
  }

  const output = [];

  while (remaining.length > width) {
    let cut = remaining.lastIndexOf(" ", width);

    if (cut < Math.floor(width / 2)) {
      cut = width;
    }

    output.push(
      remaining.slice(0, cut).trimEnd(),
    );

    remaining =
      remaining.slice(cut).trimStart();
  }

  output.push(remaining);
  return output;
}

function amount(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number.toFixed(2)
    : String(value ?? "");
}

function receiptLines(job) {
  const source = job.payload?.document ?? {};

  const header =
    source.document
    ?? source.header
    ?? {};

  const party =
    source.party
    ?? source.customer
    ?? {};

  const items = Array.isArray(source.lines)
    ? source.lines
    : [];

  const totals = Array.isArray(source.totals)
    ? source.totals
    : [];

  const metadata =
    source.meta
    ?? source.metadata
    ?? {};

  const output = [
    header.title
      ?? job.title
      ?? "NEO RECEIPT",
  ];

  if (header.number) {
    output.push(`Receipt: ${header.number}`);
  }

  if (header.date) {
    output.push(`Date: ${header.date}`);
  }

  if (party.name) {
    output.push(`Guest: ${party.name}`);
  }

  output.push("------------------------------------------");

  for (const item of items) {
    if (typeof item === "string") {
      output.push(item);
      continue;
    }

    output.push(
      `${item.quantity ?? 1} x ${
        item.description
        ?? item.name
        ?? item.item_name
        ?? "Item"
      }`,
    );

    if (
      item.total !== null
      && item.total !== undefined
    ) {
      output.push(`    ${amount(item.total)}`);
    }
  }

  output.push("------------------------------------------");

  for (const total of totals) {
    if (typeof total === "string") {
      output.push(total);
    } else {
      output.push(
        `${total.label ?? "Total"}: ${
          amount(total.amount)
        }`,
      );
    }
  }

  for (const [label, value] of Object.entries(
    metadata,
  )) {
    if (
      value !== null
      && value !== undefined
      && String(value).trim()
    ) {
      output.push(`${label}: ${value}`);
    }
  }

  output.push("", "Thank you");
  return output;
}

function render(job) {
  const payload = job.payload ?? {};

  const sourceLines = Array.isArray(payload.lines)
    ? payload.lines
    : payload.document
      ? receiptLines(job)
      : [
          job.title ?? "NEO PRINT JOB",
          JSON.stringify(payload, null, 2),
        ];

  const lines = [];

  for (const line of sourceLines) {
    if (line === null || line === undefined) {
      continue;
    }

    lines.push(...wrap(line));
  }

  return lines.join("\n");
}

function escPos(job) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from(
      `${render(job)}\n\n\n`,
      "ascii",
    ),
    Buffer.from([0x1d, 0x56, 0x00]),
  ]);
}

function networkAddress(input) {
  const value = String(input ?? "")
    .trim()
    .replace(/^tcp:\/\//i, "");

  const separator = value.lastIndexOf(":");

  if (separator <= 0) {
    return {
      host: value,
      port: 9100,
    };
  }

  const host =
    value.slice(0, separator).trim();

  const port = Number(
    value.slice(separator + 1),
  );

  if (
    !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
  ) {
    fail(`Invalid TCP printer address: ${input}`);
  }

  return { host, port };
}

async function sendTcp(address, bytes) {
  const { host, port } =
    networkAddress(address);

  if (!host) {
    fail("Network printer address is missing");
  }

  await new Promise(
    (resolvePromise, rejectPromise) => {
      let connected = false;
      let settled = false;

      const socket = createConnection({
        host,
        port,
      });

      const reject = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        error.outcomeUnknown = connected;
        rejectPromise(error);
      };

      socket.setTimeout(15000);

      socket.once("connect", () => {
        connected = true;

        socket.end(bytes, () => {
          if (settled) {
            return;
          }

          settled = true;
          resolvePromise();
        });
      });

      socket.once("timeout", () => {
        reject(
          new Error(
            `Printer connection timed out: ${host}:${port}`,
          ),
        );
      });

      socket.once("error", reject);
    },
  );
}

async function runProcess(command, args) {
  await new Promise(
    (resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: [
          "ignore",
          "ignore",
          "pipe",
        ],
      });

      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", rejectPromise);

      child.once("exit", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }

        const error = new Error(
          stderr.trim()
          || `${command} exited with code ${code}`,
        );

        error.outcomeUnknown = true;
        rejectPromise(error);
      });
    },
  );
}

async function sendWindows(
  printerName,
  bytes,
) {
  if (platform() !== "win32") {
    fail(
      "Windows spooler printing requires Windows",
    );
  }

  const name = String(printerName ?? "").trim();

  if (!name) {
    fail(
      "Windows installed printer name is missing",
    );
  }

  const temporaryFile = join(
    tmpdir(),
    `neo-print-${process.pid}-${Date.now()}.bin`,
  );

  await writeFile(temporaryFile, bytes);

  try {
    await runProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(
          scriptDirectory,
          "neo-print-raw.ps1",
        ),
        "-PrinterName",
        name,
        "-FilePath",
        temporaryFile,
      ],
    );
  } finally {
    await unlink(temporaryFile).catch(
      () => {},
    );
  }
}

function connectionType(printer) {
  return String(
    printer.connection_type ?? "",
  ).toLowerCase();
}

function supported(printer) {
  return [
    "network",
    "tcp",
    "ethernet",
    "lan",
    "windows",
    "spooler",
    "usb",
  ].includes(connectionType(printer));
}

async function deliver(job) {
  const printer = job.printer ?? {};
  const type = connectionType(printer);
  const bytes = escPos(job);

  if (
    ["network", "tcp", "ethernet", "lan"]
      .includes(type)
  ) {
    await sendTcp(printer.address, bytes);
    return;
  }

  if (
    ["windows", "spooler", "usb"]
      .includes(type)
  ) {
    await sendWindows(
      printer.address,
      bytes,
    );
    return;
  }

  fail(
    `Unsupported connection type: ${
      type || "missing"
    }`,
  );
}

async function finish(
  config,
  job,
  outcome,
  error = null,
) {
  return callApi(config, "finish", {
    job_id: job.job_id,
    claim_id: job.claim_id,
    outcome,
    error,
  });
}

async function processPrinter(
  config,
  printer,
) {
  const response = await callApi(
    config,
    "claim",
    {
      printer_id: printer.id,
    },
  );

  const job = response.job ?? null;

  if (!job) {
    return false;
  }

  console.log(
    `[${new Date().toISOString()}] Claimed ${
      job.job_id
    } for ${printer.name}`,
  );

  try {
    await deliver(job);
  } catch (error) {
    const message = String(
      error?.message ?? error,
    ).slice(0, 1000);

    const outcome = error?.outcomeUnknown
      ? "outcome_unknown"
      : "not_printed";

    console.error(
      `[${new Date().toISOString()}] ${
        outcome
      }: ${message}`,
    );

    await finish(
      config,
      job,
      outcome,
      message,
    );

    return true;
  }

  await finish(
    config,
    job,
    "completed",
  );

  console.log(
    `[${new Date().toISOString()}] Sent ${
      job.job_id
    } to ${printer.name}`,
  );

  return true;
}

async function loadPrinters(config) {
  const response = await callApi(
    config,
    "printers",
  );

  const printers = Array.isArray(
    response.printers,
  )
    ? response.printers
    : [];

  return printers.filter((printer) => {
    if (!supported(printer)) {
      console.warn(
        `Ignoring ${printer.name}: unsupported connection type "${
          printer.connection_type
        }"`,
      );

      return false;
    }

    if (
      config.printerIds
      && !config.printerIds.has(
        String(printer.id),
      )
    ) {
      return false;
    }

    return true;
  });
}

async function main() {
  const config = await loadConfig();

  console.log("NEO Print Agent");
  console.log(`Computer: ${hostname()}`);
  console.log(`API: ${config.apiBase}`);
  console.log(`Configuration: ${configPath}`);

  let printers = [];
  let refreshAt = 0;

  while (true) {
    try {
      if (Date.now() >= refreshAt) {
        printers = await loadPrinters(config);

        refreshAt =
          Date.now()
          + config.refreshMilliseconds;

        console.log(
          `[${new Date().toISOString()}] ${
            printers.length
          } supported printer(s) assigned`,
        );
      }

      let processed = false;

      for (const printer of printers) {
        processed =
          (
            await processPrinter(
              config,
              printer,
            )
          )
          || processed;
      }

      await sleep(
        processed
          ? 250
          : config.pollMilliseconds,
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ${
          error.message
        }`,
      );

      await sleep(
        Math.max(
          config.pollMilliseconds,
          5000,
        ),
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});