import { usb as usbBindings, getDeviceList } from "usb";
import { createRequire } from "node:module";

// Must come first on Windows: embed the native addon for Bun standalone binaries
// (same pattern as wallet-cli embed-usb-native.ts)
if (process.platform === "win32") {
  const _require = createRequire(import.meta.url);
  globalThis.__usbNativeAddon = _require("./node_modules/usb/prebuilds/win32-x64/node.napi.node");
}

const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node.js ${process.version}`;
console.log(`Runtime: ${runtime}`);
console.log(`Platform: ${process.platform}`);

const LEDGER_VENDOR_ID = 0x2c97;
const ENDPOINT = 3;
const FRAME_SIZE = 64;

// VID/PID override: `node index.js 2c97 4011`
const [, , argVid, argPid] = process.argv;
const filterVid = argVid ? parseInt(argVid, 16) : LEDGER_VENDOR_ID;
const filterPid = argPid ? parseInt(argPid, 16) : null;

function fmt(n) {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

function cb(resolve, reject) {
  return err => (err ? reject(err) : resolve());
}

// --- Hotplug listeners ---
usbBindings.on("attach", d => {
  const { idVendor, idProduct } = d.deviceDescriptor;
  console.log(`[attach] VID=${fmt(idVendor)} PID=${fmt(idProduct)}`);
});
usbBindings.on("detach", d => {
  const { idVendor, idProduct } = d.deviceDescriptor;
  console.log(`[detach] VID=${fmt(idVendor)} PID=${fmt(idProduct)}`);
});
process.on("exit", () => {
  usbBindings.removeAllListeners();
  usbBindings.unrefHotplugEvents();
});

// --- Find device ---
console.log(`\nLooking for VID=${fmt(filterVid)}${filterPid !== null ? ` PID=${fmt(filterPid)}` : ""}...`);
const natives = getDeviceList().filter(
  d =>
    d.deviceDescriptor.idVendor === filterVid &&
    (filterPid === null || d.deviceDescriptor.idProduct === filterPid),
);

if (natives.length === 0) {
  console.log("No matching device found. Connect a Ledger device and retry.");
  setTimeout(() => { usbBindings.unrefHotplugEvents(); process.exit(0); }, 2000);
} else {
  for (const n of natives) {
    console.log(`  Found VID=${fmt(n.deviceDescriptor.idVendor)} PID=${fmt(n.deviceDescriptor.idProduct)}`);
  }
  await run(natives[0]);
  process.exit(0);
}

async function run(device) {
  // [1] Find vendor interface (class 0xFF) from raw config descriptor
  console.log("\n[1] Finding vendor interface...");
  const config = device.configDescriptor;
  let interfaceNumber = null;
  for (const alts of config.interfaces) {
    for (const alt of alts) {
      if (alt.bInterfaceClass === 255) {
        interfaceNumber = alt.bInterfaceNumber;
        break;
      }
    }
    if (interfaceNumber !== null) break;
  }
  if (interfaceNumber === null) {
    console.log("  No vendor interface (class 0xFF) found on this device");
    return;
  }
  console.log(`  Interface: ${interfaceNumber}`);

  // [2] setupConnection — raw API
  console.log("\n[2] Setting up connection...");
  if (device.interfaces) {
    // already open — close first
    const iface = device.interface(interfaceNumber);
    try { await new Promise((res, rej) => iface.release(true, cb(res, rej))); } catch { }
    try { device.close(); } catch { }
  }

  device.open();
  console.log("  open() OK");

  await new Promise((res, rej) => device.setConfiguration(1, cb(res, rej)));
  console.log("  setConfiguration(1) OK");

  // reset() skipped: on Windows/WinUSB it triggers re-enumeration and crashes
  // in the native async callback (use-after-free). Not needed before claimInterface.

  const iface = device.interface(interfaceNumber);
  console.log("  calling claimInterface()...");
  iface.claim();
  console.log("  claimInterface() OK");

  // Find OUT and IN endpoints for ENDPOINT number
  const outEp = iface.endpoints.find(e => (e.address & 0x7f) === ENDPOINT && e.direction === "out");
  const inEp = iface.endpoints.find(e => (e.address & 0x7f) === ENDPOINT && e.direction === "in");
  if (!outEp || !inEp) {
    console.log(`  Endpoints for number ${ENDPOINT} not found on interface ${interfaceNumber}`);
    console.log(`  Available: ${iface.endpoints.map(e => `0x${e.address.toString(16)}(${e.direction})`).join(", ")}`);
    iface.release(() => { try { device.close(); } catch { } });
    return;
  }
  console.log(`  OUT ep: 0x${outEp.address.toString(16)}  IN ep: 0x${inEp.address.toString(16)}`);

  // [3] transferOut: send a framed GET_OS_VERSION APDU (0xB001000000)
  // Ledger frame: channel(2) | tag=0x05(1) | seq=0(2) | apduLen(2) | apdu(...)
  console.log("\n[3] Sending GET_OS_VERSION APDU via transferOut...");
  const apdu = new Uint8Array([0xb0, 0x01, 0x00, 0x00, 0x00]);
  const frame = Buffer.alloc(FRAME_SIZE, 0);
  frame[0] = 0x01; frame[1] = 0x01; // channel
  frame[2] = 0x05;                   // tag
  frame[3] = 0x00; frame[4] = 0x00; // sequence
  frame[5] = 0x00; frame[6] = apdu.length;
  apdu.forEach((b, i) => { frame[7 + i] = b; });

  console.log("  calling transferOut()...");
  await new Promise((res, rej) => outEp.transfer(frame, cb(res, rej)));
  console.log("  transferOut OK");

  // [4] transferIn loop
  console.log("\n[4] Reading response frames via transferIn loop...");
  for (let seq = 0; seq < 5; seq++) {
    console.log(`  calling transferIn(${seq})...`);
    const data = await new Promise((res, rej) =>
      inEp.transfer(FRAME_SIZE, (err, buf) => (err ? rej(err) : res(buf))),
    );
    const bytes = data?.byteLength ?? 0;
    console.log(`  Frame ${seq}: bytes=${bytes}`);

    if (!data || bytes === 0) break;

    if (seq === 0) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const totalLen = view.getUint16(5);
      const payload = data.slice(7, 7 + Math.min(totalLen, bytes - 7));
      console.log(`  Response payload (${totalLen} bytes): ${payload.toString("hex")}`);
      if (payload.length >= totalLen) break;
    }
  }

  // [5] closeConnection
  console.log("\n[5] Closing connection...");
  try { await new Promise((res, rej) => iface.release(true, cb(res, rej))); console.log("  releaseInterface() OK"); } catch { }
  // reset() skipped: same crash risk as in setup
  try { device.close(); console.log("  close() OK"); } catch { }
}
