import { z } from "zod";
import { round3 } from "../../core/util.js";
import { define, labeler, num, type EffectContext, type EffectDefinition } from "./helpers.js";

/**
 * Object removal (section 7.2 of docs/design/cinematic-grade-and-vfx.md). The renderer prepares
 * the fill of each removal before rendering (tools/vision/removal.ts: what other frames show behind
 * the object, and an inpainting model for what none of them shows) as a video with transparency in
 * source time; the effect lays it over the picture.
 */

export const RemovalRegionSchema = z.object({
  shape: z.enum(["rect", "ellipse"]).default("rect"),
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
});

export type RemovalRegion = z.output<typeof RemovalRegionSchema>;

export const RemoveObjectParams = z.object({
  objects: z.array(z.string()).default([]).describe("Tracked objects to remove (ids from select_object), followed through the clip"),
  regions: z
    .array(RemovalRegionSchema)
    .default([])
    .describe("Fixed areas to remove, in fractions of the source frame (remove_object converts from the edit's frame): a logo, a watermark, a date stamp, anything that stays put in the frame"),
  grow: num(0.008, 0, 0.05, "Grow the removed area by this fraction of the frame's short side, so soft edges, motion blur and a contact shadow go too"),
  feather: num(0.006, 0, 0.03, "Soft edge beyond that, as a fraction of the short side"),
});

export type RemoveObject = z.output<typeof RemoveObjectParams>;

/** What a removal's fill depends on: the stream the renderer prepares for it (EffectContext.removal). */
export interface RemovalSpec {
  objects: string[];
  regions: RemovalRegion[];
  grow: number;
  feather: number;
}

export const removalSpec = (p: RemoveObject): RemovalSpec => ({
  objects: [...new Set(p.objects)].sort(),
  regions: p.regions.map((r) => ({ shape: r.shape, x0: round3(Math.min(r.x0, r.x1)), y0: round3(Math.min(r.y0, r.y1)), x1: round3(Math.max(r.x0, r.x1)), y1: round3(Math.max(r.y0, r.y1)) })),
  grow: round3(p.grow),
  feather: round3(p.feather),
});

/** The name of a removal's prepared stream. */
export const removalKey = (spec: RemovalSpec): string => JSON.stringify(spec);

export function removalEffects(): EffectDefinition[] {
  return [
    define({
      id: "removeObject",
      name: "Remove Object",
      category: "retouch",
      description:
        "Removes tracked objects or fixed areas from a clip and fills in what was behind them: from other frames of the clip where the object moves away or the camera moves past it (real detail, exact on a locked-off shot), and from an inpainting model where no frame shows it. " +
        "Set it up with remove_object, which selects, tracks, prepares and checks it; put it first among the clip's effects so grades apply to the fill too. Primary video and photo clips only.",
      params: RemoveObjectParams,
      usesRemoval: (p) => removalSpec(p),
      toFilter: (p, ctx) => removeObjectFilter(p, ctx),
    }),
  ];
}

function removeObjectFilter(p: RemoveObject, ctx: EffectContext): string {
  const spec = removalSpec(p);
  if (!spec.objects.length && !spec.regions.length) return "null";
  const fill = ctx.removal?.(removalKey(spec));
  if (!fill) throw new Error("Object removal works on primary video and photo clips only (its fill is prepared per clip); set it up with remove_object");
  const label = labeler(ctx);
  const [base, top] = [label("rmb"), label("rmf")];
  const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
  // Past the fill's last frame, the last one holds (overlay's default), never the object.
  return [`format=${fmt}[${base}]`, `[${fill}]format=yuva420p[${top}]`, `[${base}][${top}]overlay=format=auto,format=${fmt}`].join(";");
}
