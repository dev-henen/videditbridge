# Atmosphere and light

Weather, atmosphere and light over the video: rain, snow, dust in a beam, embers, sparks, confetti, bokeh, smoke and fog, shafts of light from the sun or a lamp, and lens flares. Particles come from a seeded simulation written in Rust, so the same settings always draw the same frames, and each is a full-frame layer that mixes with the picture by a blend mode. A mask keeps it to part of the picture: snow only in the sky, embers behind a person.

## With Claude

| Tool | Use |
|---|---|
| `add_particles` | Add a preset (below) for a time range. Shape it with `density`, `size`, `speed`, `wind` (slants rain, pushes snow and smoke), `color`, `area` (where particles are born) and `ground` (where heavy rain splashes); `seed` gives another arrangement. Limit it with `mask` or `behindSubject`. By default it slows down with slow-motion footage under it (`followSpeed`) |
| `update_particles` | Change any of those settings, the preset or the duration, and draw it again. Settings not named keep their values |
| `add_light` with `kind: "rays"` | Shafts of light from a bright source: the `lightRays` effect on a clip, `all-clips`, `global` or a media layer, with a `label` (the same label updates it, `remove: true` deletes it) |
| `add_light` with `kind: "flare"` | A lens flare layer from a light at `source`, moving along a `path` or following a `track` (track_points). Its size and strength follow how bright the picture is at the source |
| `update_layer`, `animate_layer`, `remove_layer` | Blend, opacity, mask, fades and timing of a particle or flare layer |

```json
{ "tool": "add_particles", "preset": "snow", "start": 0, "duration": 12, "wind": 0.08, "mask": { "kind": "sky" } }
{ "tool": "add_particles", "preset": "heavyRain", "start": 3, "duration": 9, "wind": 0.4, "ground": 0.82, "animationIn": { "type": "fade", "duration": 1.5 } }
{ "tool": "add_particles", "preset": "embers", "start": 0, "duration": 6, "behindSubject": true, "area": { "x0": 0.3, "y0": 0.95, "x1": 0.7, "y1": 1.05 } }
{ "tool": "add_light", "kind": "rays", "target": "clip_2", "source": { "x": 0.72, "y": 0.12 }, "threshold": 0.75 }
{ "tool": "add_light", "kind": "flare", "start": 0, "duration": 5, "track": "sun", "look": "anamorphic" }
```

Weather looks real with a grade to match: rain wants a cooler, darker, flatter picture, snow a brighter and cooler one. Check every result with `render_frame` at a dark and a bright moment, and `render_preview` for the motion.

## Presets

| Preset | Blend | What it is |
|---|---|---|
| `rain` | screen | Thin pale streaks falling fast; near drops bigger and softer |
| `heavyRain` | screen | A downpour, with droplets splashing up from a ground line (`ground`, default 0.86 of the frame height) |
| `snow` | normal | Flakes of many sizes drifting down and swaying; near flakes large and out of focus |
| `dust` | screen | A few hundred specks floating in light, twinkling as they turn |
| `embers` | screen | Glowing embers rising from below, cooling from yellow to red and flickering out |
| `sparks` | add | A fountain of hot sparks thrown up and arcing down, streaked by their speed (from `area`, default the bottom middle) |
| `confetti` | normal | A burst of colored paper pieces fluttering down, spinning and tumbling |
| `bokeh` | screen | Large soft out-of-focus light orbs drifting up and fading in and out |
| `smoke` | normal | Billowing gray smoke drifting up and across, thicker low in the frame |
| `fog` | normal | Low fog rolling across, dense at the bottom and clear at the top |

Presets are data in `engine/library/particles`: an emitter (where particles are born, how many, how long they live), forces (gravity, wind, drag, turbulence), looks over each particle's life (size, opacity, color) and depth. Smoke and fog are not particles but layers of drifting fractal noise.

On a bright picture, light (screen and add) barely shows, as in a real bright scene: embers and sparks belong in darker shots. Snow, confetti, smoke and fog cover the picture and show on both.

## Masks

A media layer's `mask` limits where it shows in the picture under it (the same masks as `grade_region`):

| Kind | Comes from |
|---|---|
| `sky` | The sky of the finished main picture, found by the sky model (see [the sky guide](sky.md)) |
| `person` | The people in the finished main picture, as for `behindSubject`. `invert: true` keeps particles off them |
| `key`, `luma`, `shape` | Cut from the picture under the layer as it is rendered (`luma` with a high range for dust only in a beam of light) |

`face` and `object` masks need a clip's own footage, so they do not work on layers. The person and sky mattes of the finished picture are made once at half size and kept in the render cache until the clips or whole-video effects change; redrawing a particle layer keeps them.

## The lightRays effect

| Param | |
|---|---|
| `x`, `y` | The light, in frame fractions. Put it on the light itself |
| `threshold` | Only parts brighter than this cast rays (default 0.7; lower for a dimmer source) |
| `length` | How far rays reach: a highlight at distance d from the source streaks out to d x 20^length (default 0.5) |
| `intensity` | Brightness of the rays (default 0.8) |
| `color` | Tint (default warm sunlight, `#FFE6B8`) |

Rays come only from real highlights and are broken by whatever blocks them, so a sun behind branches or clouds gives shafts, and a bare lamp gives a soft glow.

## Flare looks

| Look | |
|---|---|
| `natural` | A spherical lens: warm glow, a short streak and a chain of faint colored ghosts and rings across the frame |
| `anamorphic` | A long thin blue streak across the frame and blue ghosts (sci-fi, night city, car lights) |
| `subtle` | A soft glow with two faint ghosts, for a light that should catch the lens without drawing attention |

## How it works

1. **The simulation** (`native/ave-native/src/particles.rs`) steps every particle twice a frame: gravity, drag toward the wind (together they set how fast things fall), and curl-noise turbulence (the curl of a smooth noise field, so the sway has no sinks or sources). Each particle gets a random depth: near ones are bigger, faster and blurrier, and there are more far ones than near ones, as in a real volume of air. Rain and snow are simulated for some seconds before the layer starts, so the first frame is already full. Falling particles that reach the ground line die there, throwing up droplets if the preset splashes.
2. **Drawing.** Every particle is a sprite: a soft disc, a streak along its motion over the shutter (rain, sparks), a spinning and tumbling rectangle (confetti, darker as it turns edge-on) or a disc with a bright rim (bokeh), with an optional glow. Light adds up (embers, sparks); everything else covers what is under it. Particles thinner than a pixel keep the light they carry instead of vanishing. The frame is split into bands of 16 rows, drawn in parallel, each painting its sprites in the same order, so the result never depends on threads.
3. **Same seed, same frames.** The simulation is sequential with its own random generator (SplitMix64), and frames come out the same whether they are asked for in one batch or many. `test/native/native.test.ts` checks this for every preset.
4. **Footage speed.** The simulated time per frame is the playback speed of the clip under it (speed ramps included), so rain falls slowly over slow motion.
5. **Into the edit.** Frames stream from Rust to an FFV1 video with transparency, which becomes a full-frame media layer. Renders only read the file; drawing happens once in the tool.
6. **Rays** (`lightRays`, FFmpeg): the picture's highlights are taken at quarter size, then 6 passes each average the picture with a copy enlarged about the source, giving 64 samples spaced evenly in log distance along every ray. The result is tinted and screened over the picture.
7. **Flares**: `add_light` looks at the finished picture 4 times a second (at most 120 frames) and measures the brightness around the source (the 90th percentile in a small disc, 0 below mid gray and 1 at clipping, fading out as the source leaves the frame). The flare's glow, streak and ghosts grow with the square root of that brightness, so a flare dims when its light is blocked. Ghosts sit on the line from the light through the frame center.

## Measured

On the reference laptop (Intel i3-1005G1, 2 cores, 4 threads):

| Check | Result |
|---|---|
| 2,000 snow particles at 1080p, generation only (the design's budget is 40 ms) | 8.8 ms a frame |
| Presets at 1080p, generation only | Snow 7.3 ms, heavy rain 8.6 ms, embers 8.4 ms, smoke 35 ms, fog 37 ms a frame |
| 5 s at 1080p drawn and encoded (FFV1) | Snow 5.6 s, heavy rain 6.0 s, embers 5.7 s, smoke and fog 10 s |
| Every preset through `add_particles` on a dark and a bright plate (`test/render/particles.integration.test.ts`) | All show on the dark plate; snow, confetti, smoke and fog also on the bright one. The pictures are written to `test/.output/particles/sheet-*.png` |
| Same seed, two separate drawings | Identical renders; another seed differs |
| Fog limited by a key mask with the default feather | Untouched to the code value beyond 12 px of the edge; across it, the fog fades smoothly with no rise or fringe |
| Snow masked to the sky (exact matte) | Nothing below the horizon |
| Rays from a sun behind branches | Shafts alternating from +2 to +118 in luma around an arc 120 px out; brightening falls from 99 to 0 between 90 and 280 px |
| A flare over a lamp, and over a dark spot | Glow and ghosts where expected; refused on the dark spot |

## Limits

- Particles are drawn at the project size whatever the preview scale, and once per tool call: changing the clips' speed under a layer needs `update_particles` to follow it.
- Weather does not interact with the scene: rain does not wet surfaces, snow does not settle, and splashes land on one ground line, not on the scene's real surfaces.
- Rays are a radial blur of the picture's own highlights; a light hidden behind something casts none.
- A flare's source sits in the frame or on its edge; for a light outside the frame, put the source on the edge nearest it.
- Checks on real footage (rain and snow over real plates, holdouts against real people and skies) wait for the test clips of the design's section 11.
