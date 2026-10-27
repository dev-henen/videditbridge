# Cross-platform: required fixes

Status: audit of 2026-10-27. The app will be built for Windows, macOS and Linux (targets and distribution: [Cinematic grading and CGI effects, section 3.6](cinematic-grade-and-vfx.md#36-platforms-windows-macos-and-linux)). Today it runs on Windows only. This document lists everything found that must change, where it is, and how to fix it.

**Severity.**

- **Blocker**: the app does not start or a feature fails on macOS or Linux.
- **Wrong result**: it runs, but the output differs between systems or breaks when a project moves between them.
- **Verify**: probably fine; confirm on each platform and add a test.
- **Polish**: works, but against platform conventions.

**Summary.** The engine (TypeScript, FFmpeg, models) is mostly portable already. The main problems are in three places:

- **The desktop app**, which is WPF and Windows-only throughout.
- **Project files**, which store absolute Windows paths for generated media.
- **Fonts**: Arial and Arial Black are the defaults everywhere and are missing on Linux.

## A. Desktop app (app/VideoEditor)

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| A1 | Blocker | `VideoEditor.csproj` (`net10.0-windows`, `UseWPF`), every view (`MainWindow.xaml`, `App.xaml`, `Controls/TimelineView.cs`) | WPF runs only on Windows | Port to Avalonia UI. Keep the view models, `EngineClient` and the JSON-RPC protocol; rewrite the views and the timeline control's drawing (`DrawingContext` to Avalonia's API). Keep the UI rules: compact 960x460, dark neutral, blue accent, no emoji or long dashes |
| A2 | Blocker | `MainWindow.xaml:91` (`MediaElement`) | Preview video plays through Windows Media Foundation | Use a cross-platform player: LibVLCSharp for Avalonia (VLC linked dynamically, LGPL 2.1: ship VLC's libraries unmodified and note the license), or later frames from the GPU engine (design doc section 3.4). Compare startup time and seeking on all three systems first |
| A3 | Blocker | `MainWindow.xaml.cs:406` (`MediaPlayer` for voice and music auditions) | Windows media API | Use the same player as A2 for audio |
| A4 | Blocker | `MainWindow.xaml.cs:10, 311, 332, 360` (`Microsoft.Win32` `OpenFolderDialog`, `OpenFileDialog`, `SaveFileDialog`) | Windows dialogs | Avalonia `StorageProvider` (open folder, open files, save file); native dialogs on each system |
| A5 | Wrong result | `App.xaml:20` (`Segoe Fluent Icons, Segoe MDL2 Assets`), `App.xaml:25` (`Segoe UI Variable Text`), `Controls/TimelineView.cs:56` (`Typeface("Segoe UI")`), icon glyph codes in views and `ViewModels/ChoiceCard.cs:17` | Windows system fonts; icons show as boxes elsewhere, and Segoe fonts may not be redistributed | Bundle Fluent UI System Icons (MIT) as the icon font and remap every glyph code (they differ from Segoe's). Use Segoe UI on Windows and a bundled UI font (Inter, OFL) on macOS and Linux. Then update the UI rule in CLAUDE.md ("icon glyphs from Segoe Fluent Icons") |
| A6 | Blocker | `Engine/EngineClient.cs:36-59` | Finds the engine by searching for the repo, and starts `node` from the PATH; an installed app has neither | Ship the host as a Node single executable application (or with a bundled Node runtime) per target, placed in the app bundle (`Contents/Resources` on macOS, next to the executable elsewhere). Look there first; keep `AVE_ENGINE_DIR` and the repo search for development |
| A7 | Blocker | `app.manifest`, `OutputType WinExe` | Windows packaging only | Avalonia app project per platform: macOS `Info.plist` and icon set, a Linux `.desktop` file and icons, and the Windows manifest kept for Windows |

## B. Projects and paths

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| B1 | Wrong result (breaks moved projects) | Generated assets in `src/claude/tools.ts`: voice-overs (`2263`), sound effects (`268-272`), freeze frames (`775-778`), graphics (`158-162`), and any other `s.outputPath` file added as an asset | Assets are saved with absolute Windows paths (`C:\Repo\...\.render\...wav`). Found in 3 of 5 projects: earphone-tips 10, short-story 11, cinematic-reel 5. They break when a project is moved, synced or opened on another system | Add one session helper that turns a file into a project path (relative to the project folder, forward slashes) and use it for every generated asset. On load, rewrite backslashes to `/` and absolute paths inside the project folder to relative ones. `validateProject` warns about absolute or backslash paths. Migrate the existing projects |
| B2 | Wrong result | Asset `src` resolution (`EditorSession.resolve`, `import_media`) | Linux file systems are case-sensitive; Windows and macOS usually are not. A project that names `Media/Clip.MP4` for `media/clip.mp4` works on Windows only | `import_media` stores the name exactly as it is on disk; `validateProject` checks that each file exists with the exact case and says so when only the case differs |
| B3 | Verify | `escapeFilterPath` (`src/library/effects/index.ts`) and the `ass` `fontsdir` (`src/tools/render/compile.ts:558`) | Escaping was written for Windows drive colons; on Linux, colons, quotes and backslashes are legal in file names | Unit tests with paths containing spaces, `:`, `'`, `\` and non-ASCII names, run on all three systems |

## C. Fonts

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| C1 | Wrong result | Defaults of `"Arial"`, `"Arial Black"` and `"Georgia"` in `src/core/schema.ts:158`, `src/library/caption-styles/index.ts:15, 68, 87`, `src/library/components/index.ts` (most components), `src/library/templates/types.ts:24-25` and the template catalog themes, `src/tools/render/text.ts:189`, the thumbnail in `src/claude/tools.ts:2671, 2680`, and the graphics fallback in `src/tools/graphics/index.ts:195` | Linux has none of these, and macOS has no Arial Black on every version. libass and resvg fall back to another face, so widths, wrapping and layout change between systems | Make bundled open fonts the defaults: Arimo for Arial (metric-compatible, Apache 2.0) and Gelasio for Georgia (metric-compatible, OFL). Arial Black has no metric-compatible open font, so choose a heavy face (for example Archivo Black) and re-check every template and component with contact sheets. Ship them in the fonts folder, always pass `fontsdir`, and map old names (`Arial` to `Arimo`) for existing projects when the original is missing |
| C2 | Blocker for user fonts on Linux | `src/tools/fonts/index.ts:90` | Linux font folders miss `~/.local/share/fonts` and `$XDG_DATA_HOME/fonts`, where current desktops install user fonts | Add both |
| C3 | Wrong result | Text with characters outside the chosen font (CJK, emoji, Arabic) | Each system falls back differently | Bundle a Noto fallback set on demand, by script, in the fonts folder, so every system uses the same fallback |

## D. FFmpeg

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| D1 | Verify | `ffmpeg-static` 5.3.0 (FFmpeg 6.1.1 on every platform, but from different builders: gyan.dev "essentials" on Windows, other static builds on macOS and Linux) | Builds can differ in libraries: libass, zimg (`zscale`), x265, libvpx, rubberband | A startup self-test (like the hardware encoder check) that confirms every filter and encoder the renderer uses (`ass`, `zscale`, `perspective`, `haldclut`, `lut3d`, `gblur`, `ffv1`, `libx264`, `libx265`, WebM decoding) and reports what is missing. Run it in CI on every target. Optional ones (`rubberband`) keep their fallbacks |
| D2 | Polish (speed) | `src/tools/render/hardware.ts:4-6` | Only NVENC, Quick Sync and AMF | Add `h264_videotoolbox` on macOS, and `h264_vaapi` (with a device and `hwupload`), Quick Sync and NVENC on Linux, each verified with a test encode as today |
| D3 | Verify | `src/tools/render/compile.ts:661, 690, 746` (`-filter_complex_script`) | Deprecated since FFmpeg 7.1 in favor of `-/filter_complex`; a newer binary on one platform would warn or fail | Pin the same FFmpeg release on every platform, or pick the option by FFmpeg version at startup |

## E. Native packages and models

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| E1 | Verify | `onnxruntime-node`, `@resvg/resvg-js`, `@huggingface/transformers`, `kokoro-js` | Must have prebuilt binaries for every target (Windows x64, macOS arm64 and x64, Linux x64) | Install and run the model tests on each target in CI |
| E2 | Polish (speed) | Model sessions in `src/tools/vision/faces.ts`, `segment.ts`, `src/tools/audio/classify.ts` | Run on the CPU on every system | Choose the GPU execution provider per platform (DirectML on Windows, CoreML on macOS, CUDA on Linux when installed), falling back to the CPU, and measure each |
| E3 | Verify | Non-English voices need the optional `espeak-ng` package (GPL-3.0) | Availability differs per platform | Test the install on each target; keep it optional |
| E4 | Polish | `~/.cache/ai-video-editor` for models and fonts on every system (`src/tools/vision/faces.ts:96`, `src/tools/fonts/index.ts:12`, `src/tools/voiceover/local.ts:227`, `src/tools/transcript/local.ts:120`) | Not where each system keeps app data | Windows: `%LOCALAPPDATA%\ai-video-editor`. macOS: `~/Library/Caches/ai-video-editor` for models, `~/Library/Application Support/ai-video-editor` for fonts. Linux: `$XDG_CACHE_HOME` and `$XDG_DATA_HOME`. Keep the `AVE_*` overrides, put the logic in one helper, and move an existing `~/.cache/ai-video-editor` folder on first run |

## F. Processes and files

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| F1 | Verify | `src/host/main.ts` | On macOS and Linux the host may be stopped by `SIGTERM` or `SIGHUP` rather than stdin closing | Handle both signals: finish pending saves and remove `.host.json`, as on a normal exit |
| F2 | Verify | Saving (`project.json` written to a temporary file, then renamed) | Rename semantics differ (Windows can refuse while a file is open) | Keep the current retry; run the save tests on all three systems |
| F3 | Note | Distribution on macOS | The app spawns FFmpeg and the host, which the Mac App Store sandbox restricts | Distribute outside the App Store (signed and notarized), as planned |

`windowsHide` options on spawned processes are ignored elsewhere and need no change.

## G. Build, test and release

| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| G1 | Blocker for confidence | No CI exists | Nothing checks macOS or Linux | GitHub Actions matrix: Windows, macOS arm64, macOS x64, Ubuntu 22.04. Run typecheck, unit tests, `docs:check` and the FFmpeg self-test on every push; render and model integration tests nightly; app builds per target |
| G2 | Blocker | Packaging | None yet | Windows: signed MSIX or MSI. macOS: signed and notarized `.app` in a DMG. Linux: AppImage, then Flatpak. Each includes the host executable, FFmpeg and the native modules; models and font packs download on first use |
| G3 | Wrong result guard | Rendering | Fonts, filters and GPU paths can differ per system | Render the test projects on each platform and compare frames; differences beyond rounding are bugs |
| G4 | Docs | `CLAUDE.md` (WPF, Segoe icons, `dotnet build app/VideoEditor`), `docs/guides/getting-started.md` | Describe the Windows-only app | Update when the Avalonia port lands |

## Order

1. **Make the engine cross-platform** (no UI work): B1, B2, B3, C1, C2, D1, E4, F1 and G1. This can be verified in CI with the CLI and the host tests on all three systems, before any app port.
2. **Port the app** to Avalonia: A1 to A7, with C3 and E2 alongside.
3. **Package and release**: G2 and G3, then D2, D3 and E3.

**Done when**: the CI matrix is green on all targets; a project made on Windows opens and renders the same on macOS and Linux (frames compared, G3); and the packaged app installs and edits a video on each system without a separately installed Node, FFmpeg or fonts.
