import { usb, getDeviceList } from "usb";

const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node.js ${process.version}`;
console.log(`Runtime: ${runtime}`);
console.log(`Platform: ${process.platform}`);

// --- 1. List all connected USB devices ---
console.log("\n[1] Listing USB devices...");
const devices = getDeviceList();
console.log(`Found ${devices.length} device(s)`);

for (const device of devices) {
  const { idVendor, idProduct } = device.deviceDescriptor;
  console.log(`  VID=0x${idVendor.toString(16).padStart(4, "0")} PID=0x${idProduct.toString(16).padStart(4, "0")}`);
}

// --- 2. Hotplug: watch for attach/detach events for 3 seconds ---
console.log("\n[2] Starting hotplug listener (3s)...");

usb.on("attach", (device) => {
  const { idVendor, idProduct } = device.deviceDescriptor;
  console.log(`  [attach] VID=0x${idVendor.toString(16).padStart(4, "0")} PID=0x${idProduct.toString(16).padStart(4, "0")}`);
});

usb.on("detach", (device) => {
  const { idVendor, idProduct } = device.deviceDescriptor;
  console.log(`  [detach] VID=0x${idVendor.toString(16).padStart(4, "0")} PID=0x${idProduct.toString(16).padStart(4, "0")}`);
});

// --- 3. Open the first available device (if any) ---
if (devices.length > 0) {
  console.log("\n[3] Attempting to open first device...");
  const device = devices[0];
  try {
    device.open();
    console.log("  Device opened successfully");
    console.log(`  Configurations: ${device.configDescriptor?.interfaces?.length ?? 0} interface(s)`);
    device.close();
    console.log("  Device closed");
  } catch (err) {
    // Access denied is expected without elevated privileges — this is not the bug
    console.log(`  Could not open device: ${err.message}`);
  }
}

// Keep event loop alive for hotplug window, then exit cleanly
setTimeout(() => {
  console.log("\nDone.");
  usb.removeAllListeners();
  process.exit(0);
}, 3000);
