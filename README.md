# bun-usb-win-crash-repro

Minimal reproduction for a crash in [Bun](https://bun.sh) when using the [`usb`](https://github.com/node-usb/node-usb) native addon on Windows.

The same script runs fine under Node.js on Windows and under both runtimes on macOS.

Extracted from [wallet-cli](https://github.com/LedgerHQ/ledger-live/tree/develop/apps/wallet-cli) in [ledger-live](https://github.com/LedgerHQ/ledger-live).

## What the script does

Mirrors the wallet-cli USB transport layer (`NodeWebUsbApduSender` + `NodeWebUsbTransport`):

1. Registers hotplug `attach`/`detach` listeners (calls `unrefHotplugEvents` on exit)
2. Finds a Ledger device (VID `0x2C97`) via `getDeviceList()`
3. Creates a `WebUSBDevice` instance and finds the vendor interface (class `0xFF`)
4. **`setupConnection`**: `open()` → `selectConfiguration(1)` → `reset()` → `claimInterface()`
5. **`sendApdu`**: sends a framed `GET_OS_VERSION` APDU (`0xB001000000`) via `transferOut(3, frame)`
6. **`receiveResponseFrames`**: reads response frames in a `transferIn(3, 64)` loop
7. **`closeConnection`**: `releaseInterface()` → `reset()` → `close()`

## Patch applied

`patches/usb@2.17.0.patch` (same as wallet-cli) makes two changes:

- **`dist/usb/bindings.js`** — checks `globalThis.__usbNativeAddon` before calling `node-gyp-build`, so Bun standalone binaries can embed the prebuilt `.node` file
- **`dist/usb/index.js`** — calls `emitHotplugEvents` directly instead of via `setTimeout`, removing the debounce delay on attach/detach events (rolling back [node-usb#577](https://github.com/node-usb/node-usb/pull/577))

## Expected behaviour

All steps complete (or time out gracefully) on both runtimes.

## Actual behaviour (Windows + Bun)

Bun crashes — typically a segfault or a hard process exit with no JS-level error — during the `transferIn`/`transferOut` async callbacks or hotplug event handling.

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
