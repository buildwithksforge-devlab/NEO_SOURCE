import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverPrinters} from './neo-printer-discovery.mjs';

// Discovery only: never loads an agent token, polls jobs or sends print data.
export async function runDiscovery(kind, discover = discoverPrinters) {
  if (!['network','windows','usb','bluetooth'].includes(kind)) {
    throw Error('Choose network, windows, usb or bluetooth for read-only discovery.');
  }
  return discover(kind);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDiscovery(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
