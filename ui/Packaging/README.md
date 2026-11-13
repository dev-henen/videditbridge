# Packaging metadata

Per-system files for the desktop app. Building installers (MSIX or MSI, a signed DMG, an AppImage) is a later step; these are the pieces each one uses.

| System | Files |
|---|---|
| Windows | `../app.manifest` (per-monitor DPI), `../Assets/AppIcon.ico` (the executable's icon) |
| macOS | `macOS/Info.plist`; `AppIcon.icns` made from `icons/` with `iconutil` |
| Linux | `linux/videditbridge.desktop`; icons from `icons/` installed as `hicolor/<size>x<size>/apps/videditbridge.png` |

`logo.jpg` is the source of every icon (the VideditBridge logo). After changing it, run `npx tsx scripts/make-icons.ts`: it cuts the light background away (keeping the white inside the logo), crops it square and writes `AppIcon.png` (1024, the master), `icons/AppIcon-<size>.png` (16 to 1024), `../Assets/AppIcon.png` (256, the window icon) and `../Assets/AppIcon.ico` (16 to 256).

## Where things go in an installed app

- The engine goes next to the executable in an `engine` folder, or in `Contents/Resources/engine` on macOS (see `EngineClient.BundledHost`). It is either a single executable `ave-host`, or a Node runtime `node` with `dist/host/main.js`, plus FFmpeg, the native modules and the `fonts` folder.
- Projects go to `Documents/VideditBridge` unless `AVE_PROJECTS_DIR` is set.
- VLC's libraries come with the app on Windows (`VideoLAN.LibVLC.Windows`) and macOS (`VideoLAN.LibVLC.Mac`). Linux uses the system's libvlc: the package depends on `vlc` (Debian and Ubuntu: `libvlc5` and `vlc-plugin-base`; Flatpak: the VLC extension).

Licenses of what ships with the app are in `../THIRD-PARTY-NOTICES.md`.
