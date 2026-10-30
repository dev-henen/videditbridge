# native

Rust code of ai-video-editor, as one Cargo workspace. See [the design](../docs/design/cinematic-grade-and-vfx.md), section 3.5, for what moves to Rust and why.

| Crate | Ships as | Holds |
|---|---|---|
| `ave-native` | A Node addon (napi-rs), loaded by [engine/tools/native/index.ts](../engine/tools/native/index.ts) | CPU kernels: `frameFeatures` (audio analysis), `trackRegion` (region tracking: Lucas-Kanade and RANSAC), `warpMasks` and `guidedFilter` (object mattes) |

## Building

```sh
npm run native          # release build for this machine, copied to native/ave-native/ave-native.<target>.node
npm run native -- --debug
cd native && cargo test --release
```

Needs Rust from [rustup](https://rustup.rs). On Windows the addon is an MSVC build (the script adds the `x86_64-pc-windows-msvc` target and runs cargo inside the Visual Studio environment), so it also needs the Visual Studio C++ build tools and the Windows SDK. The GNU toolchain cannot build Node addons there.

Users never build this: CI builds the addon for every target and keeps it as a build artifact (`ave-native-<os>`). Publishing those as per-platform npm packages (`@ai-video-editor/native-<target>`, which the loader tries first) is not set up yet.

## Rules for kernels

- Coarse calls: a whole buffer per call, never per frame or per pixel across the boundary.
- Work runs off the JavaScript thread (`AsyncTask`, with rayon inside) and returns a promise.
- A panic becomes a JavaScript error, never a crash of the host.
- Every port keeps the old TypeScript as a test oracle (`test/helpers/`) with a parity test (`test/native/native.test.ts`), and records a benchmark in the guide that uses it.
