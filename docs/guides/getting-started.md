# Getting started

## Install

```bash
npm install
```

You need Node 20 or newer. FFmpeg comes from the optional `ffmpeg-static` dependency. To use a different binary, set `FFMPEG_PATH` or pass `ffmpegPath` to the render functions. The binary must be built with libass and libfreetype for text and captions.

Check that everything works:

```bash
npm test
npx tsx engine/cli.ts templates
npx tsx engine/cli.ts check   # this FFmpeg build has every filter and codec the renderer uses
```

### Where downloads go

Models download on first use into the models folder, and installed fonts go into the fonts folder. Each system has its own location:

| System | Models (`$AVE_MODELS_DIR`) | Fonts (`$AVE_FONTS_DIR`) |
|---|---|---|
| Windows | `%LOCALAPPDATA%\ai-video-editor\models` | `%LOCALAPPDATA%\ai-video-editor\fonts` |
| macOS | `~/Library/Caches/ai-video-editor/models` | `~/Library/Application Support/ai-video-editor/fonts` |
| Linux | `$XDG_CACHE_HOME/ai-video-editor/models` (`~/.cache`) | `$XDG_DATA_HOME/ai-video-editor/fonts` (`~/.local/share`) |

Folders from older versions in `~/.cache/ai-video-editor` move to these places on first use. The face, person cutout and sound models measure the graphics card against the CPU the first time they run on a computer, keep the faster one and save it next to the model (`<model>.provider.json`). Delete that file to measure again; `AVE_ORT_PROVIDERS=cpu` or `gpu` overrides the choice. The default fonts (Arimo, Archivo Black, Gelasio, Anton, Cousine, Comic Neue; all OFL) ship in the package's `fonts` folder and are copied into the fonts folder, so text renders the same on every system. Projects that name Arial, Arial Black, Georgia, Impact, Courier New or Comic Sans MS get those fonts on systems that lack the originals.

## Your first render

```ts
import { createProject, addAsset, addClip, addLayer, render } from "ai-video-editor";

let p = createProject({ name: "Hello", aspectRatio: "9:16" });
p = addAsset(p, { type: "video", id: "clip", src: "footage.mp4" });
p = addClip(p, { assetId: "clip", in: 0, duration: 5, effects: [{ type: "cinematic" }] });
p = addLayer(p, {
  type: "text",
  text: "Hello world",
  start: 0.3,
  duration: 3,
  position: { x: 0.5, y: 0.2 },
  style: { fontSize: 90, uppercase: true },
  animationIn: { type: "pop" },
  animationOut: { type: "fade" },
});

await render(p, { output: "out/hello.mp4" });
```

`render` probes media first to fill in durations, sizes and whether each file has audio. It then compiles the project to an FFmpeg filter graph and runs FFmpeg.

## Look before you render

```ts
import { renderFrame, renderContactSheet, summarizeProject, validateProject } from "ai-video-editor";

console.log(summarizeProject(p));                 // text timeline
console.log(validateProject(p).issues);           // problems to fix
await renderFrame(p, 1.5, { output: "out/frame.png", scale: 0.5 });
await renderContactSheet(p, { output: "out/sheet.png", columns: 4, rows: 3 });
```

## Start from a template

```ts
import { applyTemplate, probe, render } from "ai-video-editor";

const { project, warnings } = await applyTemplate(
  "listicle-countdown",
  {
    title: "3 apps that save me hours",
    items: [
      { media: "notion.mp4", label: "Notion" },
      { media: "raycast.png", label: "Raycast" },
      { media: "arc.mp4", label: "Arc" },
    ],
    cta: "Follow for more tools",
    music: "upbeat.mp3",
  },
  { probe: (src) => probe(src) },
);
await render(project, { output: "out/list.mp4" });
```

Browse the [template reference](../reference/templates.md) or run `ave templates <query>`.

## Watch edits live

Open the project in the desktop app (ui; build it with `dotnet build ui`). It shows the timeline, frames and preview video as Claude edits. Click the picture to point Claude at a spot (for example to select an object); once Claude selected one, its outline shows in blue on still frames (the Object toggle). Matte shows the mask of the clip under the playhead, or of the clip picked on the timeline, white on black. In the Review tab, picking a finding goes to its moment and shows the scopes of that frame under the list. See [Rendering & preview](rendering-and-preview.md).

## Next

- Let Claude do the editing: [Claude integration](claude-integration.md)
- Edit talking-head footage by transcript: [Transcripts & captions](transcripts-and-captions.md)
