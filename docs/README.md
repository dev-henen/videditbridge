# Documentation

## Guides

| Guide | Covers |
|---|---|
| [Getting started](guides/getting-started.md) | Install, render your first video, build from a template |
| [The project document](guides/project-format.md) | The JSON edit format: assets, clips, layers, audio, captions, timing rules |
| [Claude integration](guides/claude-integration.md) | Sessions, tool execution, the agent loop, letting Claude see its work, the future MCP connector |
| [Transcripts & captions](guides/transcripts-and-captions.md) | Importing and producing transcripts, correcting names, speech search, filler/pause removal, caption styling and export |
| [Design: cinematic grading & CGI](design/cinematic-grade-and-vfx.md) | Movie-level grading and VFX: checklist of what is built and what is left, quality bar, architecture |
| [Design: cross-platform fixes](design/cross-platform.md) | Everything that must change for Windows, macOS and Linux, with locations and fixes |
| [Graphics, 3D & custom effects](guides/graphics.md) | SVG graphics Claude designs and animates, 3D layers, custom FFmpeg effects, font packs |
| [Templates](guides/templates.md) | How templates work and how to write your own (slots, scenes, placeholders) |
| [Rendering & preview](guides/rendering-and-preview.md) | FFmpeg setup, renders, frames, contact sheets, proxies, automatic review of an edit |
| [GPU render engine & performance test](guides/render-engine.md) | Rendering the picture on the graphics card, what it draws so far, how it matches FFmpeg, and the first-run test that picks the renderer |
| [Color correction & grading](guides/color.md) | Exposure, white balance, tone, HSL, curves, color wheels, finishing, analysis and scopes |
| [Voice-over](guides/voiceover.md) | Text-to-speech providers and narrated edits |
| [Faces, cutouts & reframing](guides/faces.md) | Local face detection and tracking, person cutout for background blur and replacement, reframing 16:9 for 9:16, text over faces |
| [Selecting & tracking objects](guides/objects.md) | Select any object by box, point or name, follow it through the clips, and limit effects and grades to it |
| [Tracking points & surfaces](guides/tracking.md) | Follow a point or a flat surface, pin layers to it, and put a new picture on a screen or sign |
| [Sky masks & replacement](guides/sky.md) | Find the sky on every frame, grade it, and replace it with a picture or gradient that moves with the camera |
| [Depth](guides/depth.md) | Depth of every frame, depth of field and rack focus, depth masks, fog by distance, and 2.5D moves through photos |
| [Removing objects](guides/removal.md) | Take a tracked object or a fixed area (a logo, a sign) out of clips and photos, rebuilt from other frames, with an inpainting model for what no frame shows |
| [Slow motion & frame rates](guides/slow-motion.md) | Smooth slow motion, speed ramps and frame rate conversion, with frames made in between by a model instead of repeated |
| [Atmosphere & light](guides/atmosphere-and-light.md) | Rain, snow, dust, embers, sparks, confetti, bokeh, smoke and fog as seeded particle layers, masked to the sky or behind people; light rays and lens flares |
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
