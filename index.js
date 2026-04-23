import { usb, getDeviceList } from "usb";
import { promisify } from "util";

const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node.js ${process.version}`;
console.log(`Runtime: ${runtime}`);
console.log(`Platform: ${process.platform}`);

// Optional VID/PID filter: `node index.js 2c97 0004`
const [, , argVid, argPid] = process.argv;
const filterVid = argVid ? parseInt(argVid, 16) : null;
const filterPid = argPid ? parseInt(argPid, 16) : null;

function fmt(n) {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

// --- 1. List all connected USB devices ---
console.log("\n[1] Listing USB devices...");
const devices = getDeviceList();
console.log(`Found ${devices.length} device(s)`);
for (const d of devices) {
  const { idVendor, idProduct } = d.deviceDescriptor;
  const match = (filterVid === null || filterVid === idVendor) && (filterPid === null || filterPid === idProduct);
  console.log(`  VID=${fmt(idVendor)} PID=${fmt(idProduct)}${match && (filterVid !== null) ? "  ← target" : ""}`);
}

// --- 2. Hotplug listener ---
console.log("\n[2] Starting hotplug listener...");
usb.on("attach", (d) => {
  const { idVendor, idProduct } = d.deviceDescriptor;
  console.log(`  [attach] VID=${fmt(idVendor)} PID=${fmt(idProduct)}`);
});
usb.on("detach", (d) => {
  const { idVendor, idProduct } = d.deviceDescriptor;
  console.log(`  [detach] VID=${fmt(idVendor)} PID=${fmt(idProduct)}`);
});

// --- 3. Find target device ---
const target = devices.find(({ deviceDescriptor: { idVendor, idProduct } }) =>
  (filterVid === null || filterVid === idVendor) &&
  (filterPid === null || filterPid === idProduct)
);

if (!target) {
  console.log(filterVid !== null
    ? `\nNo device found with VID=${fmt(filterVid)}${filterPid !== null ? ` PID=${fmt(filterPid)}` : ""}. Plug one in and retry.`
    : "\nNo USB devices found."
  );
  setTimeout(() => { usb.removeAllListeners(); process.exit(0); }, 3000);
} else {
  const { idVendor, idProduct } = target.deviceDescriptor;
  console.log(`\n[3] Opening VID=${fmt(idVendor)} PID=${fmt(idProduct)}...`);
  await communicate(target);
  setTimeout(() => { usb.removeAllListeners(); process.exit(0); }, 3000);
}

async function communicate(device) {
  // Open
  device.open();
  console.log("  Opened");

  // Control transfer: GET_DESCRIPTOR (Device) — safe read-only operation
  console.log("  Sending GET_DESCRIPTOR control transfer...");
  const controlTransfer = promisify(device.controlTransfer.bind(device));
  try {
    const descriptor = await controlTransfer(
      0x80,   // bmRequestType: device-to-host, standard, device
      0x06,   // bRequest: GET_DESCRIPTOR
      0x0100, // wValue: Device Descriptor
      0x0000, // wIndex
      18      // length: device descriptor is 18 bytes
    );
    console.log(`  GET_DESCRIPTOR response (${descriptor.length} bytes): ${descriptor.toString("hex")}`);
  } catch (err) {
    console.log(`  GET_DESCRIPTOR failed: ${err.message}`);
  }

  // Find the first IN endpoint (interrupt or bulk) across all interfaces
  const iface = findFirstInEndpoint(device);
  if (iface) {
    const { interfaceNumber, endpoint } = iface;
    console.log(`\n[4] Claiming interface ${interfaceNumber}, endpoint 0x${endpoint.address.toString(16)}...`);
    try {
      device.interface(interfaceNumber).claim();
      console.log("  Interface claimed");

      // Async transfer — this is the most likely crash site in Bun on Windows
      console.log("  Submitting async IN transfer (64 bytes, 1s timeout)...");
      endpoint.timeout = 1000;
      const transfer = promisify(endpoint.transfer.bind(endpoint));
      try {
        const data = await transfer(64);
        console.log(`  Transfer received ${data.length} bytes: ${data.toString("hex")}`);
      } catch (err) {
        // LIBUSB_TRANSFER_TIMED_OUT is expected if nothing to read — not the bug
        console.log(`  Transfer result: ${err.message}`);
      }

      device.interface(interfaceNumber).release(true, (err) => {
        if (err) console.log(`  Release error: ${err.message}`);
        else console.log("  Interface released");
        device.close();
        console.log("  Closed");
      });
    } catch (err) {
      console.log(`  Could not claim interface: ${err.message}`);
      device.close();
      console.log("  Closed");
    }
  } else {
    console.log("\n  No IN endpoint found, skipping transfer step");
    device.close();
    console.log("  Closed");
  }
}

function findFirstInEndpoint(device) {
  const config = device.configDescriptor;
  if (!config) return null;
  for (const iface of config.interfaces ?? []) {
    for (const alt of iface) {
      for (const ep of alt.endpoints ?? []) {
        // 0x80 bit set = IN direction
        if (ep.direction === "in") {
          return { interfaceNumber: alt.interfaceNumber, endpoint: device.interface(alt.interfaceNumber).endpoint(ep.bEndpointAddress) };
        }
      }
    }
  }
  return null;
}
