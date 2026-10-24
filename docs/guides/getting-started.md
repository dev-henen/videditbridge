# Getting started

## Install

```bash
npm install
```

You need Node 20 or newer. FFmpeg comes from the optional `ffmpeg-static` dependency. To use a different binary, set `FFMPEG_PATH` or pass `ffmpegPath` to the render functions. The binary must be built with libass and libfreetype for text and captions.

Check that everything works:

```bash
npm test
npx tsx src/cli.ts templates
```

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

```bash
ave preview project.json
```

This opens a local page that redraws the timeline and frames every time `project.json` changes. See [Rendering & live preview](rendering-and-preview.md).

## Next

- Let Claude do the editing: [Claude integration](claude-integration.md)
- Edit talking-head footage by transcript: [Transcripts & captions](transcripts-and-captions.md)
