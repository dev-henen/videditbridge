# Packaging metadata

Per-system files for the desktop app. Building installers (MSIX or MSI, a signed DMG, an AppImage) is a later step; these are the pieces each one uses.

The developer is Moses Henen, and the app's home is [github.com/dev-henen/videditbridge](https://github.com/dev-henen/videditbridge) (user guide at [dev-henen.github.io/videditbridge](https://dev-henen.github.io/videditbridge/), problems at its issues page). Every package says so:

| Where | What it carries |
|---|---|
| `../VideditBridge.csproj` | Version, Authors, Company, Copyright and the repository: the Windows executable's properties |
| `macOS/Info.plist` | Bundle id `io.github.dev-henen.videditbridge`, the copyright |
| `linux/io.github.dev_henen.videditbridge.metainfo.xml` | AppStream: the developer, the homepage, issues and source links, the license (what software centers and Flathub show) |
| `../../package.json` | The engine's author, homepage, repository and issues |

The ids follow Flathub's rule for GitHub projects: `io.github.<user>.<app>`, with `_` for the `-` in the user name on Linux (AppStream ids cannot have `-`); macOS keeps the `-`.

| System | Files |
|---|---|
| Windows | `../app.manifest` (per-monitor DPI), `../Assets/AppIcon.ico` (the executable's icon) |
| macOS | `macOS/Info.plist`; `AppIcon.icns` made from `icons/` with `iconutil` |
| Linux | `linux/io.github.dev_henen.videditbridge.desktop` and `.metainfo.xml` (to `/usr/share/applications` and `/usr/share/metainfo`); icons from `icons/` installed as `hicolor/<size>x<size>/apps/io.github.dev_henen.videditbridge.png` |

`logo.jpg` is the source of every icon (the VideditBridge logo). After changing it, run `npx tsx scripts/make-icons.ts`: it cuts the light background away (keeping the white inside the logo), crops it square and writes `AppIcon.png` (1024, the master), `icons/AppIcon-<size>.png` (16 to 1024), `../Assets/AppIcon.png` (256, the window icon) and `../Assets/AppIcon.ico` (16 to 256).

## Where things go in an installed app

- The engine goes next to the executable in an `engine` folder, or in `Contents/Resources/engine` on macOS (see `EngineClient.BundledHost`). It is either a single executable `ave-host`, or a Node runtime `node` with `dist/host/main.js`, plus FFmpeg, the native modules and the `fonts` folder.
- **Every model comes with the app**, in `engine/models`: nothing downloads on first use, and every feature works offline from the start. `npx tsx scripts/bundle-models.ts <folder>` fills the folder (about 1 GB) from the list in `engine/tools/bundled-models.ts`; `test/repo/bundled-models.test.ts` fails when the engine loads a model that is not on it. The engine finds the folder next to its own executable (`bundledModelsDir`, or `AVE_BUNDLED_MODELS_DIR`) and reads the models in place. Kokoro's voices ship inside the `kokoro-js` package.
- Projects go to `Documents/VideditBridge` unless `AVE_PROJECTS_DIR` is set.
- VLC's libraries come with the app on Windows (`VideoLAN.LibVLC.Windows`) and macOS (`VideoLAN.LibVLC.Mac`). Linux uses the system's libvlc: the package depends on `vlc` (Debian and Ubuntu: `libvlc5` and `vlc-plugin-base`; Flatpak: the VLC extension).

Licenses of what ships with the app, the models included, are in `../THIRD-PARTY-NOTICES.md`.
