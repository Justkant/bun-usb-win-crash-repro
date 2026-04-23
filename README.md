# bun-usb-win-crash-repro

Minimal reproduction for a crash in [Bun](https://bun.sh) when using the [`usb`](https://github.com/node-usb/node-usb) native addon on Windows.

The same script runs fine under Node.js on Windows and under both runtimes on macOS.

## What the script does

1. Lists all connected USB devices via `usb.getDeviceList()`
2. Registers hotplug `attach`/`detach` listeners for 3 seconds
3. Attempts to open (then immediately close) the first found device

## Expected behaviour

All three steps complete without error on both runtimes.

## Actual behaviour (Windows + Bun)

Bun crashes — typically a segfault or a hard process exit with no JS-level error — during USB enumeration or hotplug initialisation.

## Setup

```
# Node.js (requires node-gyp toolchain for native rebuild)
pnpm install
pnpm node

# Bun
pnpm install
pnpm bun
```

> On Windows you may need to run as Administrator or install a WinUSB/libusb driver
> via [Zadig](https://zadig.akeo.ie/) for device access. The crash occurs even without
> an open device, so elevated privileges are not required to reproduce it.

## Environment

| | macOS | Windows |
|---|---|---|
| Node.js | ✅ works | ✅ works |
| Bun | ✅ works | ❌ crashes |

## Versions used

- `usb` 2.17.0
- Bun (see `bun --version`)
- Node.js (see `node --version`)
