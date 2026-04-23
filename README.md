# bun-usb-win-crash-repro

Minimal reproduction for a crash in [Bun](https://bun.sh) when using the [`usb`](https://github.com/node-usb/node-usb) native addon on Windows.

The same script runs fine under Node.js on Windows and under both runtimes on macOS.

## What the script does

1. Lists all connected USB devices via `usb.getDeviceList()`
2. Registers hotplug `attach`/`detach` listeners
3. Opens a target device and performs a `GET_DESCRIPTOR` control transfer
4. Claims the first available IN endpoint and submits an async transfer

Steps 3 and 4 are where the crash surfaces on Windows + Bun.

## Expected behaviour

All steps complete (or time out gracefully) on both runtimes.

## Actual behaviour (Windows + Bun)

Bun crashes — typically a segfault or a hard process exit with no JS-level error — during the async transfer callback from libusb.

## Setup

```
pnpm install
```

Run against the first available device:

```
pnpm node        # Node.js
pnpm bun         # Bun
```

Target a specific device by VID and PID (hex, no `0x` prefix):

```
# e.g. Ledger Nano X
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
