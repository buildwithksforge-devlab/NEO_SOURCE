import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

function dnsName(packet, start, depth = 0) {
  if (depth > 16) throw Error("DNS pointer cycle");
  let offset = start,
    name = [],
    end;
  for (let steps = 0; steps < 128; steps++) {
    if (offset >= packet.length) throw Error("Truncated DNS name");
    const length = packet[offset++];
    if (length === 0) return { name: name.join(".").toLowerCase(), end: end ?? offset };
    if ((length & 0xc0) === 0xc0) {
      if (offset >= packet.length) throw Error("Truncated DNS pointer");
      const pointer = ((length & 0x3f) << 8) | packet[offset++];
      name.push(dnsName(packet, pointer, depth + 1).name);
      return { name: name.join(".").toLowerCase(), end: end ?? offset };
    }
    if (length > 63 || offset + length > packet.length) throw Error("Invalid DNS label");
    name.push(packet.toString("utf8", offset, offset + length));
    offset += length;
  }
  throw Error("DNS name too long");
}
export function decodePrinterDns(packet) {
  if (packet.length < 12 || !(packet.readUInt16BE(2) & 0x8000)) return [];
  const questions = packet.readUInt16BE(4),
    count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (questions > 100 || count > 512) throw Error("Oversized DNS record count");
  let offset = 12;
  const records = [];
  for (let i = 0; i < questions; i++) {
    offset = dnsName(packet, offset).end + 4;
    if (offset > packet.length) throw Error("Truncated DNS question");
  }
  for (let i = 0; i < count; i++) {
    const owner = dnsName(packet, offset);
    offset = owner.end;
    if (offset + 10 > packet.length) throw Error("Truncated DNS record");
    const type = packet.readUInt16BE(offset),
      length = packet.readUInt16BE(offset + 8),
      start = offset + 10,
      end = start + length;
    if (end > packet.length) throw Error("Truncated DNS data");
    if (type === 33 && length >= 7) {
      const target = dnsName(packet, start + 6);
      if (target.end > end) throw Error("Invalid SRV target");
      records.push({
        name: owner.name,
        type,
        port: packet.readUInt16BE(start + 4),
        target: target.name,
      });
    }
    if (type === 1 && length === 4)
      records.push({ name: owner.name, type, address: [...packet.subarray(start, end)].join(".") });
    if (type === 12) {
      const target = dnsName(packet, start);
      if (target.end > end) throw Error("Invalid PTR target");
      records.push({ name: owner.name, type, target: target.name });
    }
    offset = end;
  }
  return records;
}
export function printerDnsQuery(questions = [
  { name: "_pdl-datastream._tcp.local", type: 12 },
  { name: "_ipp._tcp.local", type: 12 },
  { name: "_ipps._tcp.local", type: 12 },
]) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4e45, 0);
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([
    header,
    ...questions.map(({ name: service, type }) =>
      Buffer.concat([
        ...service
          .split(".")
          .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
        Buffer.from([0, type >> 8, type & 255, 0, 1]),
      ]),
    ),
  ]);
}
export async function discoverNetwork({ duration = 3500, socketFactory = createSocket } = {}) {
  const records = [];
  const notes = [];
  await new Promise((resolve) => {
    const socket = socketFactory({ type: "udp4", reuseAddr: true });
    const asked = new Set();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, duration);
    socket.on("error", (error) => {
      notes.push(`Local network discovery unavailable: ${error.message}`);
      finish();
    });
    socket.on("message", (packet) => {
      if (records.length > 1000) return;
      try {
        records.push(...decodePrinterDns(packet));
        // Some printers omit additional SRV/A records from their browse reply.
        // Resolve only advertised printer instances and their local hosts.
        const questions = [];
        for (const row of records) {
          let name, type;
          if (row.type === 12 && /\._(?:pdl-datastream|ipps?)\._tcp\.local$/.test(row.target)) {
            name = row.target; type = 33;
          } else if (row.type === 33 && /\._(?:pdl-datastream|ipps?)\._tcp\.local$/.test(row.name)
            && row.target.endsWith(".local")) {
            name = row.target; type = 1;
          } else continue;
          const key = `${type}:${name}`;
          if (asked.has(key) || asked.size >= 128 || records.some(r => r.type === type && r.name === name)) continue;
          asked.add(key);
          questions.push({ name, type });
        }
        if (!done && questions.length) socket.send(printerDnsQuery(questions), 5353, "224.0.0.251", error => {
          if (error) notes.push(error.message);
        });
      } catch {
        /* Ignore malformed local advertisements. */
      }
    });
    // Legacy unicast mDNS query: ephemeral source port, replies return to this socket.
    socket.bind(0, () => {
      if (done) return;
      socket.send(printerDnsQuery(), 5353, "224.0.0.251", (error) => {
        if (error) {
          notes.push(error.message);
          finish();
        }
      });
    });
  });
  const printers = [];
  const seen = new Set();
  for (const record of records.filter((row) => row.type === 33)) {
    const raw = record.name.endsWith("._pdl-datastream._tcp.local");
    if (
      !raw &&
      !record.name.endsWith("._ipp._tcp.local") &&
      !record.name.endsWith("._ipps._tcp.local")
    )
      continue;
    const address = records.find((row) => row.type === 1 && row.name === record.target)?.address;
    if (!address || record.port < 1 || record.port > 65535) continue;
    const key = `${address}:${record.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    printers.push({
      name: record.name.split("._")[0].slice(0, 240),
      address: key,
      connection_type: raw ? "network" : "unsupported",
      transport: "network",
      source: "Local mDNS advertisement",
      note: raw
        ? "RAW service advertised; verify ESC/POS compatibility and test output."
        : "IPP printer detected. Install its Windows queue; direct IPP printing is not implemented.",
    });
  }
  return {
    printers: printers.slice(0, 100),
    notes: [
      ...notes,
      "mDNS searches this computer’s local network. Printers that do not advertise may need their IP address or an installed Windows queue.",
    ],
  };
}
export function windowsInventory(kind, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./neo-printer-discovery.ps1", import.meta.url)),
        "-Kind",
        kind,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      done = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("Windows printer search timed out"));
    }, 15000);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 200000) {
        child.kill();
        finish(Error("Windows printer inventory too large"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(Error(stderr.trim() || "Windows printer inventory failed"));
      try {
        finish(null, JSON.parse(stdout.replace(/^\uFEFF/, "")));
      } catch {
        finish(Error("Windows printer inventory returned invalid JSON"));
      }
    });
  });
}
export async function discoverPrinters(
  kind,
  { os = platform(), inventory = windowsInventory, network = discoverNetwork } = {},
) {
  if (!["network", "windows", "usb", "bluetooth"].includes(kind))
    throw Error("Unsupported discovery kind");
  const result = { printers: [], notes: [] };
  if (os === "win32") {
    try {
      const local = await inventory(kind);
      result.printers.push(...local.printers);
      result.notes.push(...(local.notes ?? []));
    } catch (error) {
      result.notes.push(error.message);
    }
  } else if (kind !== "network")
    result.notes.push("Installed USB/Bluetooth queue discovery requires a Windows property agent.");
  if (kind === "network") {
    const local = await network();
    result.printers.push(...local.printers);
    result.notes.push(...local.notes);
  }
  result.printers = result.printers.slice(0, 100);
  return result;
}
export async function probeTcp(address, { timeout = 2000 } = {}) {
  const match = String(address).match(/^([^\s:/]+)(?::(\d+))?$/);
  if (!match) throw Error("Use a hostname or IPv4 address and TCP port");
  const port = Number(match[2] ?? 9100);
  if (port < 1 || port > 65535) throw Error("Invalid TCP port");
  return new Promise((resolve) => {
    const socket = createConnection({ host: match[1], port });
    let done = false;
    function finish(reachable) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable, address, proof: "TCP connection only; no print bytes sent" });
    }
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
