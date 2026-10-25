export type TransitionCategory = "basic" | "wipe" | "slide" | "shape" | "stylized";

export interface TransitionDefinition {
  id: string;
  name: string;
  category: TransitionCategory;
  description: string;
  /** FFmpeg xfade transition name. */
  xfade: string;
  /** Suggested duration in seconds. */
  defaultDuration: number;
  /**
   * Sound effect that matches the motion (a swoosh for a slide, a whoosh for a whip), placed by
   * set_transition with sound: true. Calm transitions (fades, dissolves) have none.
   */
  sound?: string;
}

/** Moving transitions get a sound that matches their motion. */
function soundFor(id: string, category: TransitionCategory): string | undefined {
  if (["pixelize", "glitch"].includes(id)) return "glitch";
  if (["hblur", "whip", "zoomin", "hlwind", "hrwind", "distance"].includes(id) || id.startsWith("smooth")) return "whoosh";
  if (category === "slide" || category === "wipe" || /slice$/.test(id)) return "swoosh";
  if (["circleopen", "circleclose", "horzopen", "vertopen", "horzclose", "vertclose", "radial"].includes(id)) return "whoosh";
  return undefined;
}

const t = (
  id: string,
  name: string,
  category: TransitionCategory,
  description: string,
  defaultDuration = 0.5,
  xfade = id,
): TransitionDefinition => {
  const sound = soundFor(id, category);
  return { id, name, category, description, xfade, defaultDuration, ...(sound ? { sound } : {}) };
};

export const TRANSITIONS: TransitionDefinition[] = [
  t("fade", "Crossfade", "basic", "Smooth dissolve between clips. Safe default for any content.", 0.5),
  t("fadeblack", "Dip to Black", "basic", "Fade out to black then into the next clip. Signals a scene/time change.", 0.8),
  t("fadewhite", "Dip to White", "basic", "Flash to white between clips. Dreamy or energetic.", 0.6),
  t("dissolve", "Dissolve", "basic", "Grainy pixel dissolve.", 0.6),
  t("fadegrays", "Fade Through Gray", "basic", "Desaturate while crossfading.", 0.7),
  t("wipeleft", "Wipe Left", "wipe", "Hard-edge wipe moving left.", 0.5),
  t("wiperight", "Wipe Right", "wipe", "Hard-edge wipe moving right.", 0.5),
  t("wipeup", "Wipe Up", "wipe", "Hard-edge wipe moving up.", 0.5),
  t("wipedown", "Wipe Down", "wipe", "Hard-edge wipe moving down.", 0.5),
  t("smoothleft", "Smooth Wipe Left", "wipe", "Soft-edge wipe to the left.", 0.6),
  t("smoothright", "Smooth Wipe Right", "wipe", "Soft-edge wipe to the right.", 0.6),
  t("smoothup", "Smooth Wipe Up", "wipe", "Soft-edge wipe upward.", 0.6),
  t("smoothdown", "Smooth Wipe Down", "wipe", "Soft-edge wipe downward.", 0.6),
  t("diagtl", "Diagonal Wipe", "wipe", "Diagonal wipe from the top-left corner.", 0.6),
  t("slideleft", "Slide Left", "slide", "Next clip pushes in from the right. Great for lists and sequences.", 0.4),
  t("slideright", "Slide Right", "slide", "Next clip pushes in from the left.", 0.4),
  t("slideup", "Slide Up", "slide", "Next clip pushes in from the bottom. Feels like scrolling a feed.", 0.4),
  t("slidedown", "Slide Down", "slide", "Next clip pushes in from the top.", 0.4),
  t("coverleft", "Cover Left", "slide", "Next clip slides over the current one from the right.", 0.4),
  t("coverright", "Cover Right", "slide", "Next clip slides over the current one from the left.", 0.4),
  t("revealleft", "Reveal Left", "slide", "Current clip slides away to the left revealing the next.", 0.4),
  t("revealright", "Reveal Right", "slide", "Current clip slides away to the right revealing the next.", 0.4),
  t("squeezeh", "Squeeze Horizontal", "slide", "Squeeze horizontally into the next clip.", 0.5),
  t("squeezev", "Squeeze Vertical", "slide", "Squeeze vertically into the next clip.", 0.5),
  t("circleopen", "Iris Open", "shape", "Circle opens from the center revealing the next clip.", 0.6),
  t("circleclose", "Iris Close", "shape", "Circle closes toward the center.", 0.6),
  t("circlecrop", "Circle Crop", "shape", "Circular crop through black.", 0.7),
  t("rectcrop", "Rectangle Crop", "shape", "Rectangular crop through black.", 0.7),
  t("radial", "Clock Wipe", "shape", "Radial clock-hand sweep.", 0.6),
  t("horzopen", "Barn Door Open (H)", "shape", "Opens horizontally from the center.", 0.5),
  t("vertopen", "Barn Door Open (V)", "shape", "Opens vertically from the center.", 0.5),
  t("horzclose", "Barn Door Close (H)", "shape", "Closes horizontally toward the center.", 0.5),
  t("vertclose", "Barn Door Close (V)", "shape", "Closes vertically toward the center.", 0.5),
  t("pixelize", "Pixelize", "stylized", "Pixelate out and back in. Retro / gaming feel.", 0.6),
  t("hblur", "Motion Blur", "stylized", "Horizontal blur whip between clips.", 0.4),
  t("zoomin", "Zoom In", "stylized", "Zoom into the current clip while fading to the next. Energetic.", 0.5),
  t("distance", "Distance", "stylized", "Distorted morph between clips.", 0.6),
  t("hlslice", "Slice Left", "stylized", "Sliced horizontal wipe.", 0.5),
  t("hrslice", "Slice Right", "stylized", "Sliced horizontal wipe the other way.", 0.5),
  t("vuslice", "Slice Up", "stylized", "Sliced vertical wipe upward.", 0.5),
  t("vdslice", "Slice Down", "stylized", "Sliced vertical wipe downward.", 0.5),
  t("hlwind", "Wind Left", "stylized", "Wind-swept streaks to the left.", 0.6),
  t("hrwind", "Wind Right", "stylized", "Wind-swept streaks to the right.", 0.6),
  t("squeeze", "Squeeze", "stylized", "Alias of squeezev.", 0.5, "squeezev"),
  t("whip", "Whip Pan", "stylized", "Fast blurred whip pan. Alias of hblur with a short duration.", 0.25, "hblur"),
  t("glitch", "Glitch Cut", "stylized", "Short pixelize burst, reads as a digital glitch.", 0.25, "pixelize"),
];

const byId = new Map(TRANSITIONS.map((tr) => [tr.id, tr]));

export function getTransition(id: string): TransitionDefinition | undefined {
  return byId.get(id);
}

export function listTransitions(category?: TransitionCategory): TransitionDefinition[] {
  return category ? TRANSITIONS.filter((tr) => tr.category === category) : TRANSITIONS;
}
