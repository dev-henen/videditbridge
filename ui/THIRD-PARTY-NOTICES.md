# Third-party software in the desktop app

| Component | License | Use |
|---|---|---|
| [Avalonia UI](https://avaloniaui.net) | MIT | The window and controls on Windows, macOS and Linux |
| [LibVLCSharp](https://code.videolan.org/videolan/LibVLCSharp) | LGPL 2.1 or later | Video and audio playback, linked dynamically |
| [VLC / libvlc](https://www.videolan.org/vlc/libvlc.html) | LGPL 2.1 or later | Playback engine. Its libraries ship unmodified on Windows and macOS (the VideoLAN.LibVLC packages), and come from the system on Linux. Its source is available from VideoLAN, and the libraries can be replaced with other compatible builds. |
| [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) | MIT (`Assets/Fonts/FluentSystemIcons-LICENSE.txt`) | Icon font |
| [Inter](https://rsms.me/inter/) | SIL Open Font License 1.1 | UI font on macOS and Linux (Avalonia.Fonts.Inter) |

The engine's bundled fonts (Arimo, Archivo Black, Gelasio, Anton, Cousine, Comic Neue) are under the SIL Open Font License 1.1. Their license texts are in the repository's `fonts` folder.
