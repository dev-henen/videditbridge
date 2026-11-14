# Third-party software in the desktop app

| Component | License | Use |
|---|---|---|
| [Avalonia UI](https://avaloniaui.net) | MIT | The window and controls on Windows, macOS and Linux |
| [LibVLCSharp](https://code.videolan.org/videolan/LibVLCSharp) | LGPL 2.1 or later | Video and audio playback, linked dynamically |
| [VLC / libvlc](https://www.videolan.org/vlc/libvlc.html) | LGPL 2.1 or later | Playback engine. Its libraries ship unmodified on Windows and macOS (the VideoLAN.LibVLC packages), and come from the system on Linux. Its source is available from VideoLAN, and the libraries can be replaced with other compatible builds. |
| [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) | MIT (`Assets/Fonts/FluentSystemIcons-LICENSE.txt`) | Icon font |
| [Inter](https://rsms.me/inter/) | SIL Open Font License 1.1 | UI font on macOS and Linux (Avalonia.Fonts.Inter) |

The engine's bundled fonts (Arimo, Archivo Black, Gelasio, Anton, Cousine, Comic Neue) are under the SIL Open Font License 1.1. Their license texts are in the repository's `fonts` folder.

## Models

The installed app carries these models in `engine/models` (the list is `engine/tools/bundled-models.ts`). They run on the computer, with ONNX Runtime (MIT).

| Model | License | Use |
|---|---|---|
| [YuNet](https://huggingface.co/opencv/face_detection_yunet) (OpenCV) | MIT | Finding faces |
| [PP-HumanSeg](https://huggingface.co/opencv/human_segmentation_pphumanseg) (PaddleSeg, from the OpenCV model zoo) | Apache-2.0 | Cutting out people |
| [CED-tiny](https://huggingface.co/mispeech/ced-tiny) | Apache-2.0 | Telling speech, music and other sounds apart |
| [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) | Apache-2.0 | Depth (focus, fog, parallax) |
| [skyseg](https://huggingface.co/JianyuanWang/skyseg) (U-2-Net trained for sky) | MIT | Sky replacement |
| [LaMa](https://huggingface.co/Carve/LaMa-ONNX) (big-lama) | Apache-2.0 | Object removal |
| [RIFE 4.9](https://huggingface.co/FuryTMP/RIFE_v4.9) (Practical-RIFE) | MIT | Smooth slow motion |
| [Whisper base](https://huggingface.co/onnx-community/whisper-base.en_timestamped) (OpenAI; English and [multilingual](https://huggingface.co/onnx-community/whisper-base_timestamped)) | MIT | Transcription |
| [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | Apache-2.0 | Voice-over |
| [SAM 2.1 hiera tiny](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX) (Meta) | Apache-2.0 | Selecting objects |
| [OWLv2 base](https://huggingface.co/Xenova/owlv2-base-patch16-ensemble) (Google) | Apache-2.0 | Finding a named object |
