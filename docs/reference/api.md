# Library API

Everything is exported from the package root. Each area also has its own entry point. Dependencies only point downward: `claude → tools → library → core`.

## `ai-video-editor/core`

The engine model. Pure, with no I/O.

| Export | |
|---|---|
| `ProjectSchema`, `parseProject`, `projectJsonSchema`, the types `Project`, `Clip`, `Layer`, `AudioClip`, `Asset`, `Transcript`… | The document schema |
| `createProject({ aspectRatio, ...})` | New project with defaults |
| `addAsset`, `upsertAsset`, `removeAsset`, `setTranscript` | Assets |
| `addClip`, `updateClip`, `removeClip`, `moveClip`, `trimClip`, `splitClip`, `setTransition`, `setAllTransitions` | Primary track |
| `addEffect`, `removeEffect` | Effects on a clip, a media layer or `"global"` |
| `addAudioEffect`, `removeAudioEffect`, `setAudioEffectParams` | Audio effects on a clip, an audio clip, a media layer or `"master"` |
| `setSpeed`, `setVolume` | Speed of a clip or audio clip; volume of a clip, audio clip, media layer or `"master"` |
| `addLayer`, `updateLayer`, `removeLayer`, `reorderLayer` | Layers |
| `addAudio`, `updateAudio`, `removeAudio` | Audio |
| `setCaptions`, `updateSettings` | Captions, resolution, fps |
| `cutTimelineRanges`, `cutSourceRanges`, `assembleFromRanges` | Cutting and reassembling |
| `computeTimeline`, `clipAtTime`, `sourceToTimeline`, `timelineToSource` | Timeline math |
| `validateProject` | `{ ok, issues }` |
| `summarizeProject` | Readable timeline text |
| `mergeRanges`, `invertRanges` | Range helpers |
| `ASPECT_RATIOS`, `dimensionsFor`, `formatTime`, `toAssColor`, `toFfmpegColor`, `newId` | Utilities |

All operations return a **new** project and never mutate their input.

## `ai-video-editor/library`

Catalogs. Each one has `list…`, `get…` and, where it makes sense, `register…`.

| Area | Exports |
|---|---|
| Effects | `EFFECTS`, `getEffect`, `listEffects`, `registerEffect`, `effectToFilter`, `resolveEffectParams`, `SubjectRegionSchema` |
| Audio effects | `AUDIO_EFFECTS`, `getAudioEffect`, `listAudioEffects`, `registerAudioEffect`, `audioEffectToFilter`, `atempoChain` |
| Transitions | `TRANSITIONS`, `getTransition`, `listTransitions` |
| Animations | `ANIMATIONS`, `getAnimation`, `listAnimations` |
| Caption styles | `CAPTION_STYLES`, `CaptionStyleSchema`, `getCaptionStyle`, `listCaptionStyles`, `resolveCaptionStyle`, `registerCaptionStyle` |
| Components | `COMPONENTS`, `getComponent`, `listComponents`, `registerComponent`, `buildComponentLayers`, `addComponent` |
| Templates | `TEMPLATES`, `getTemplate`, `listTemplates`, `registerTemplate`, `describeTemplate`, `buildFromTemplate`, `applyTemplate`, `TemplateSpecSchema` |

## `ai-video-editor/tools`

| Area | Exports |
|---|---|
| Transcript | `parseTranscript`, `fromSRT`, `fromVTT`, `fromWhisper`, `fromDeepgram`, `fromAssemblyAI`, `fromPlainText`, `sentences`, `formatTranscript`, `searchTranscript`, `findFillers`, `findRepetitions`, `findSilences`, `transcriptStats`, `sliceTranscript`, `planCleanup`, `cleanupSpeech`, `transcribeMedia`, `extractAudio`, `OpenAITranscriber`, `DeepgramTranscriber` |
| Captions | `timelineWords`, `buildCaptions`, `chunkWords`, `exportCaptions`, `chunksToSRT`, `chunksToVTT`, `AssDocument` |
| Voice-over | `OpenAITTS`, `ElevenLabsTTS`, `alignmentToWords` |
| Render | `render`, `renderFrame`, `renderContactSheet`, `compileProject`, `probe`, `probeAssets`, `runFfmpeg`, `resolveFfmpegPath` |
| Preview | `startPreviewServer`, `previewState` |

## `ai-video-editor/claude`

| Export | |
|---|---|
| `EditorSession` | Project state with `commit`, `undo`/`redo`, `history`, `renders`, `revision`, and `change`/`render`/`log` events |
| `TOOLS`, `getTool`, `registerTool`, `executeTool` | Tool definitions, custom tools, execution |
| `toAnthropicTools` | Messages API `tools` array |
| `toToolResultContent` | `tool_result` content blocks (text + images) |
