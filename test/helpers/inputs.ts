import type { TemplateInputs, TemplateSpec } from "../../src/library/templates/index.js";
import type { Transcript } from "../../src/core/index.js";

export interface SampleMedia {
  video: string;
  image: string;
  audio: string;
  videoDuration: number;
  audioDuration: number;
  transcript?: Transcript;
}

/** Fill every slot of a template with plausible sample inputs. */
export function sampleInputs(t: TemplateSpec, m: SampleMedia, listLength = 3): TemplateInputs {
  const video = () => ({ src: m.video, duration: m.videoDuration, hasAudio: true, ...(m.transcript ? { transcript: m.transcript } : {}) });
  const inputs: TemplateInputs = {};
  for (const slot of t.slots) {
    switch (slot.kind) {
      case "text":
        inputs[slot.id] = `${slot.id} text`;
        break;
      case "video":
      case "media":
        inputs[slot.id] = video();
        break;
      case "image":
        inputs[slot.id] = m.image;
        break;
      case "audio":
        inputs[slot.id] = { src: m.audio, duration: m.audioDuration, ...(m.transcript && slot.id !== "music" ? { transcript: m.transcript } : {}) };
        break;
      case "list":
        inputs[slot.id] = Array.from({ length: listLength }, (_, i) =>
          Object.fromEntries(
            Object.keys(slot.fields ?? { media: "" }).map((f) => [
              f,
              f === "media" ? (i % 2 ? m.image : video()) : f === "seconds" ? 2 : f === "speed" ? 1 : `${f} ${i + 1}`,
            ]),
          ),
        );
        break;
    }
  }
  return inputs;
}
