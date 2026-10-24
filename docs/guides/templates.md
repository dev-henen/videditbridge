# Templates

A template describes a *style* of video: what inputs it needs, how it looks, and how its scenes are structured. Each template is pure JSON (`TemplateSpec`, defined in [src/library/templates/types.ts](../../src/library/templates/types.ts)) and is interpreted by one builder, so:

- Claude can read a template (`get_template`) and follow its `aiGuidance` when choosing and cutting footage,
- new templates are data, not code, and Claude can write them too,
- the result is an ordinary project that stays fully editable.

All built-in templates are listed in the [template reference](../reference/templates.md).

## Using a template

```ts
const { project, warnings } = await applyTemplate("viral-talking-head", inputs, {
  probe: (src) => probe(src),          // fills media durations so scenes can follow media length
  aspectRatio: "1:1",                  // optional override
  theme: { accentColor: "#FF3366" },   // optional theme override
});
```

`buildFromTemplate(spec, inputs)` is the synchronous version. Pass `{ src, duration }` for media so scene lengths come out right.

### Inputs

Inputs map slot ids to values:

| Slot kind | Value |
|---|---|
| `text` | string |
| `video`, `image`, `media` | a path, or `{ src, in?, duration?, hasAudio?, transcript? }` |
| `audio` | the same shape |
| `list` | an array of objects using the slot's `fields`, e.g. `[{ media: "a.mp4", label: "Step 1" }]` |

Passing `transcript` on a media input enables the template's captions for that media.

## Anatomy of a spec

```jsonc
{
  "id": "my-promo",
  "name": "My Promo",
  "description": "One-line summary shown in listings",
  "category": "promo",                      // social | youtube | business | education | personal | promo | entertainment
  "tags": ["launch"], "platforms": ["Instagram"],
  "aspectRatio": "9:16", "fps": 30,
  "idealDuration": [10, 20],
  "aiGuidance": "How an AI should pick and cut footage to match this style.",
  "slots": [
    { "id": "headline", "kind": "text", "description": "Main message", "required": true },
    { "id": "shots", "kind": "list", "description": "Product shots", "fields": { "media": "Clip", "label": "Benefit" } },
    { "id": "music", "kind": "audio", "description": "Optional music" }
  ],
  "theme": { "headingFont": "Arial Black", "accentColor": "#FFBE0B", "backgroundColor": "#101010" },
  "captions": { "style": "bold-pop" },      // used when a transcript is present
  "transition": { "type": "slideup", "duration": 0.3 },   // default between scenes
  "grade": [{ "type": "vibrant" }],         // global effects
  "music": { "slot": "music", "volume": 0.4, "duck": true },
  "voiceover": { "slot": "voiceover" },
  "scenes": [ /* see below */ ]
}
```

### Scenes

Scenes play in order. Each scene becomes one primary clip, plus the layers on top of it.

```jsonc
{
  "id": "shot",
  "name": "Shot",
  "purpose": "Show one benefit",             // guidance for the AI
  "repeat": "shots",                          // one scene per list item
  "optional": false,                          // skip when referenced inputs are empty
  "duration": 3,                              // default length
  "fitMedia": false,                          // use the background media's own length (capped by maxDuration)
  "durationFrom": "{{item.seconds}}",         // or: a number / media with a known duration
  "background": { "media": "{{item.media}}", "consume": false, "fit": "cover", "muted": false, "speed": 1 },
  // or { "color": "#000000" } / { "gradient": ["#FF006E", "#3A0CA3"], "direction": "diagonal" }
  "effects": [{ "type": "kenBurns" }],
  "transition": null,                         // null = hard cut into this scene; omit to use the default
  "texts": [{ "text": "{{item.label}}", "preset": "heading", "position": { "x": 0.5, "y": 0.8 }, "start": 0.2 }],
  "components": [{ "component": "number-badge", "params": { "number": "{{index}}" } }],
  "overlays": [{ "media": "{{logo}}", "position": { "x": 0.9, "y": 0.08 }, "size": { "width": 0.15 } }]
}
```

- **`consume: true`** continues a single long media from where the previous scene stopped. The *viral talking head* uses it to make a 3s hook scene and then a body scene from one recording.
- **Text presets** are `title`, `heading`, `subtitle`, `body`, `caption`, `kicker`, `big-number` and `footer`. They pick font, size, color and default animation from the theme. Override anything with `style`.
- **Layer timing** is relative to the scene start. Layers default to running until the scene ends, and they are placed after transitions are resolved.

### Placeholders

Any string can contain:

| Placeholder | Resolves to |
|---|---|
| `{{slot}}` | an input value |
| `{{slot.0.media}}` | indexing into lists |
| `{{item}}`, `{{item.field}}` | the current item in a `repeat` scene |
| `{{index}}` | the 1-based item number |
| `{{theme.accentColor}}` | a theme value |

A text whose placeholders are all empty is skipped. A component param that resolves to empty is dropped so the component's default applies; if that param was required, the component is skipped without a warning. A component `assetId` param that points at a media slot (e.g. `"{{logo}}"`) is added to the project as an asset.

## Registering

```ts
registerTemplate(spec);                       // validates; throws if the id exists
registerTemplate(spec, { replace: true });
```

To ship a template with the library, add it to a file in `src/library/templates/catalog/` and run `npm run docs`. The test suite builds every template with sample inputs and checks that the result validates.
