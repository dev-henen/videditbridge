# Documentation

## Guides

| Guide | Covers |
|---|---|
| [Getting started](guides/getting-started.md) | Install, render your first video, build from a template |
| [The project document](guides/project-format.md) | The JSON edit format: assets, clips, layers, audio, captions, timing rules |
| [Claude integration](guides/claude-integration.md) | Sessions, tool execution, the agent loop, letting Claude see its work, the future MCP connector |
| [Transcripts & captions](guides/transcripts-and-captions.md) | Importing and producing transcripts, speech search, filler/pause removal, caption styling and export |
| [Templates](guides/templates.md) | How templates work and how to write your own (slots, scenes, placeholders) |
| [Rendering & live preview](guides/rendering-and-preview.md) | FFmpeg setup, renders, frames, contact sheets, the preview server |
| [Color correction & grading](guides/color.md) | Exposure, white balance, tone, HSL, curves, color wheels, finishing, analysis and scopes |
| [Voice-over](guides/voiceover.md) | Text-to-speech providers and narrated edits |
| [Retouch & audio](guides/retouch-and-audio.md) | Beauty retouch, background blur, voice cleanup, audio effects, speed and volume |
| [Editing raw footage](guides/raw-footage.md) | Sound maps (speech, silence, music), silence removal, shot detection, beat sync, moment effects and sound effects |
| [Roadmap](roadmap.md) | Suggested improvements, in priority order, and why each matters |

## Reference

| Reference | |
|---|---|
| [Claude tools](reference/claude-tools.md) | All Claude tools with their parameters |
| [Templates](reference/templates.md) | All 33 templates: inputs, scenes, look and editing guidance |
| [Effects](reference/effects.md) | Color controls, grades, retouch, bokeh and blur, light, zooms, shakes and stylize effects with parameters |
| [Audio effects](reference/audio-effects.md) | Noise reduction, voice enhancement, dynamics, EQ and creative sound effects |
| [Sound effects](reference/sound-effects.md) | Synthesized whooshes, impacts, pops, risers and other sounds to place on the timeline |
| [Transitions](reference/transitions.md) | Transitions between clips |
| [Animations](reference/animations.md) | Entrance and exit animations for layers |
| [Caption styles](reference/caption-styles.md) | Caption presets and the fields you can override |
| [Components](reference/components.md) | Lower-thirds, CTAs, title cards and other composite elements |
| [Library API](reference/api.md) | What each module exports |
| [CLI](reference/cli.md) | The `ave` command |

Pages marked "Generated" come from the source code. After changing a catalog or tool, run `npm run docs`. `npm run docs:check` (also run by the test suite) fails if they are out of date.
