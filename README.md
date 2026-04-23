# bun-usb-win-crash-repro

Minimal reproduction for a crash in [Bun](https://bun.sh) when using the [`usb`](https://github.com/node-usb/node-usb) native addon on Windows.

Extracted from [wallet-cli](https://github.com/LedgerHQ/ledger-live/tree/develop/apps/wallet-cli) in [ledger-live](https://github.com/LedgerHQ/ledger-live).

**Branch `raw-api`**: uses the raw libusb API (`device.open()`, `iface.claim()`, `endpoint.transfer()`) instead of the WebUSB abstraction layer (`WebUSBDevice`), to isolate whether the crash originates in the WebUSB wrapper or the underlying native bindings.

## What the script does

Same operations as the `main` branch but via raw libusb API:

1. Registers hotplug `attach`/`detach` listeners (calls `unrefHotplugEvents` on exit)
2. Finds a Ledger device (VID `0x2C97`) via `getDeviceList()`
3. Finds the vendor interface (class `0xFF`) from `device.configDescriptor`
4. **setup**: `device.open()` → `device.setConfiguration(1)` → `device.reset()` → `iface.claim()`
5. **send**: sends a framed `GET_OS_VERSION` APDU (`0xB001000000`) via `OutEndpoint.transfer(frame)`
6. **receive**: reads response frames in an `InEndpoint.transfer(64)` loop
7. **close**: `iface.release()` → `device.reset()` → `device.close()`

## Patch applied

`patches/usb@2.17.0.patch` (same as wallet-cli) makes two changes:

- **`dist/usb/bindings.js`** — checks `globalThis.__usbNativeAddon` before calling `node-gyp-build`, so Bun standalone binaries can embed the prebuilt `.node` file
- **`dist/usb/index.js`** — calls `emitHotplugEvents` directly instead of via `setTimeout`, removing the debounce delay on attach/detach events (rolling back [node-usb#577](https://github.com/node-usb/node-usb/pull/577))

## Expected behaviour

All steps complete (or time out gracefully) on both runtimes.

## Actual behaviour (Windows + Bun) — `main` branch

Bun crashes — typically a segfault or a hard process exit with no JS-level error — during the `transferIn`/`transferOut` async callbacks or hotplug event handling.

The same crash is reproduced with Node.js on Windows (see `main` branch), confirming the issue is in `node-usb` itself rather than the Bun runtime.

## Purpose of `raw-api` branch

To determine whether the crash is in the WebUSB abstraction layer (`WebUSBDevice`) or in the underlying native bindings. If this branch also crashes, the bug is in the core libusb async callback path; if it does not, the WebUSB wrapper is the culprit.

## Setup

```
pnpm install
```

Run against a connected Ledger device (defaults to VID `0x2C97`):

```
pnpm node        # Node.js
pnpm bun         # Bun
```

Target a specific PID:

```
pnpm node 2c97 4011
pnpm bun  2c97 4011
```

> On Windows you may need to install a WinUSB/libusb driver via
> [Zadig](https://zadig.akeo.ie/) for the target device before libusb can open it.

## Environment

| | macOS | Windows |
|---|---|---|
| Node.js | ✅ works | ✅ works |
| Bun | ✅ works | ❌ crashes |

## Versions used

- `usb` 2.17.0
- Bun (see `bun --version`)
- Node.js (see `node --version`)
