import { usb as usbBindings, getDeviceList, WebUSBDevice } from "usb";
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

// --- Hotplug listeners (same as NodeWebUsbTransport.startListeningToConnectionEvents) ---
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

// Mirrors NodeWebUsbApduSender.setupConnection + sendApdu + receiveResponseFrames + closeConnection
async function run(native) {
  // [1] Create WebUSBDevice (same as WebUSBDevice.createInstance in transport)
  console.log("\n[1] Creating WebUSBDevice instance...");
  const device = await WebUSBDevice.createInstance(native);
  console.log(`  VID=${fmt(device.vendorId)} PID=${fmt(device.productId)}`);

  // Find vendor interface (class 0xFF) — same as getVendorInterfaceNumber()
  const cfg = device.configurations[0];
  let interfaceNumber = null;
  for (const iface of cfg?.interfaces ?? []) {
    if (iface.alternates.some(a => a.interfaceClass === 255)) {
      interfaceNumber = iface.interfaceNumber;
      break;
    }
  }
  if (interfaceNumber === null) {
    console.log("  No vendor interface (class 0xFF) found on this device");
    return;
  }
  console.log(`  Interface: ${interfaceNumber}`);

  // [2] setupConnection (mirrors NodeWebUsbApduSender.setupConnection)
  console.log("\n[2] Setting up connection...");
  if (device.opened) {
    try { await device.releaseInterface(interfaceNumber); } catch { }
    // reset() skipped: on Windows/WinUSB it triggers re-enumeration and crashes
    // in the native async callback (use-after-free).
    try { await device.close(); } catch { }
  }
  await device.open();
  console.log("  open() OK");

  if (device.configuration === null) {
    await device.selectConfiguration(1);
    console.log("  selectConfiguration(1) OK");
  }

  // reset() skipped: crash site on Windows/WinUSB (see raw-api branch for details).

  await device.claimInterface(interfaceNumber);
  console.log("  claimInterface() OK");

  // selectAlternateInterface sends SET_INTERFACE to the device, which resets endpoint
  // data-toggle bits on both host and device. This is needed because selectConfiguration
  // is a no-op when config 1 is already active on WinUSB, leaving device-side toggles
  // out of sync and causing transferIn to time out on every run after the first.
  console.log("  calling selectAlternateInterface(0)...");
  try {
    await device.selectAlternateInterface(interfaceNumber, 0);
    console.log("  selectAlternateInterface(0) OK");
  } catch (e) { console.log(`  selectAlternateInterface(0) error: ${e?.message ?? e}`); }

  // Drain stale frames from the IN endpoint. WebUSB has no per-transfer timeout, but
  // WebUSBDevice wraps the same native endpoint objects as node-usb, so setting timeout
  // on the underlying InEndpoint is respected by device.transferIn().
  const nativeInEp = native.interface(interfaceNumber).endpoints
    .find(e => (e.address & 0x7f) === ENDPOINT && e.direction === "in");
  if (nativeInEp) {
    nativeInEp.timeout = 100;
    let drained = 0;
    while (true) {
      try {
        const r = await device.transferIn(ENDPOINT, FRAME_SIZE);
        if (r.status !== "ok") break;
        drained++;
      } catch { break; }
    }
    nativeInEp.timeout = 3000;
    if (drained > 0) console.log(`  drained ${drained} stale frame(s) from IN endpoint`);
  }

  // [3] transferOut: send a framed GET_OS_VERSION APDU (0xB001000000)
  // Ledger frame: channel(2) | tag=0x05(1) | seq=0(2) | apduLen(2) | apdu(...)
  console.log("\n[3] Sending GET_OS_VERSION APDU via transferOut...");
  const apdu = new Uint8Array([0xb0, 0x01, 0x00, 0x00, 0x00]);
  const frame = new Uint8Array(FRAME_SIZE).fill(0);
  frame[0] = 0x01; frame[1] = 0x01; // channel
  frame[2] = 0x05;                   // tag
  frame[3] = 0x00; frame[4] = 0x00; // sequence
  frame[5] = 0x00; frame[6] = apdu.length;
  frame.set(apdu, 7);

  const outResult = await device.transferOut(ENDPOINT, frame.buffer);
  console.log(`  transferOut status: ${outResult.status}`);

  // [4] transferIn loop (mirrors receiveResponseFrames)
  console.log("\n[4] Reading response frames via transferIn loop...");
  for (let seq = 0; seq < 5; seq++) {
    const r = await device.transferIn(ENDPOINT, FRAME_SIZE);
    const bytes = r.data?.byteLength ?? 0;
    console.log(`  Frame ${seq}: status=${r.status} bytes=${bytes}`);

    if (r.status !== "ok" || !r.data) break;

    const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    if (seq === 0) {
      // Parse response length from first frame: channel(2)+tag(1)+seq(2)+len(2)
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const totalLen = view.getUint16(5);
      const payload = chunk.slice(7, 7 + Math.min(totalLen, bytes - 7));
      console.log(`  Response payload (${totalLen} bytes): ${Buffer.from(payload).toString("hex")}`);
      if (payload.length >= totalLen) break;
    }
  }

  // [5] closeConnection (mirrors NodeWebUsbApduSender.closeConnection)
  console.log("\n[5] Closing connection...");
  try { await device.releaseInterface(interfaceNumber); console.log("  releaseInterface() OK"); } catch { }
  // reset() skipped: crash site on Windows/WinUSB.
  try { await device.close(); console.log("  close() OK"); } catch { }
}
