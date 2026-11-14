import { rm } from "node:fs/promises";
import path from "node:path";
import { SOUND_LABELS, SOUND_MODEL } from "./audio/classify.js";
import { LocalWhisperTranscriber } from "./transcript/local.js";
import { INTERPOLATE_MODEL } from "./video/interpolate.js";
import { DEPTH_MODEL } from "./vision/depth.js";
import { ensureModelFile, FACE_MODEL } from "./vision/faces.js";
import { DETECT_MODEL, OBJECT_MODEL } from "./vision/objects.js";
import { INPAINT_MODEL } from "./vision/removal.js";
import { PERSON_MODEL } from "./vision/segment.js";
import { SKY_MODEL } from "./vision/sky.js";
import { LocalTTS } from "./voiceover/local.js";

/**
 * Every model the app uses, which an installed app carries in its `engine/models` folder
 * (`bundledModelsDir`), so nothing downloads on first use. All are MIT or Apache-2.0 licensed
 * (ui/THIRD-PARTY-NOTICES.md). `scripts/bundle-models.ts` fills the folder from this list;
 * `test/repo/bundled-models.test.ts` checks that every model the engine loads is on it.
 */

/** Single-file models, at `<folder>/<file>` (loaded with `ensureModelFile`). */
export const FILE_MODELS = [
  { folder: "yunet", model: FACE_MODEL, use: "faces" },
  { folder: "pphumanseg", model: PERSON_MODEL, use: "person cutout" },
  { folder: "ced-tiny", model: SOUND_MODEL, use: "sound classes" },
  { folder: "ced-tiny", model: SOUND_LABELS, use: "sound class names" },
  { folder: "depth", model: DEPTH_MODEL, use: "depth" },
  { folder: "sky", model: SKY_MODEL, use: "sky" },
  { folder: "inpaint", model: INPAINT_MODEL, use: "object removal" },
  { folder: "interpolate", model: INTERPOLATE_MODEL, use: "smooth slow motion" },
] as const;

/** transformers.js models, at `<model id>/<file>`, loaded as the tools load them (task and precision). */
export const TRANSFORMERS_MODELS = [
  { id: new LocalWhisperTranscriber().modelFor("en"), kind: "asr", dtype: "q8", use: "transcription (English)" },
  { id: new LocalWhisperTranscriber().modelFor("fr"), kind: "asr", dtype: "q8", use: "transcription (other languages)" },
  { id: new LocalTTS().model, kind: "kokoro", dtype: "q8", use: "voice-over" },
  { id: OBJECT_MODEL.id, kind: "sam2", dtype: OBJECT_MODEL.dtype, use: "object selection" },
  { id: DETECT_MODEL.id, kind: "detect", dtype: DETECT_MODEL.dtype, use: "finding a named object" },
] as const;

/** A few tries: a large download can lose its connection part way (a failed file is not kept). */
async function retried<T>(what: string, log: (line: string) => void, run: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= tries) throw e;
      log(`  ${what} failed (${e instanceof Error ? e.message : String(e)}), trying again`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Load one transformers.js model as the tools do (it downloads into the cache folder when missing). */
async function loadTransformersModel(m: (typeof TRANSFORMERS_MODELS)[number]): Promise<void> {
  const tf = await import("@huggingface/transformers");
  if (m.kind === "asr") {
    const p = await tf.pipeline("automatic-speech-recognition", m.id, { dtype: m.dtype });
    await p.dispose();
  } else if (m.kind === "kokoro") {
    const kokoro = await import("kokoro-js");
    await kokoro.KokoroTTS.from_pretrained(m.id, { dtype: m.dtype, device: "cpu" } as Parameters<typeof kokoro.KokoroTTS.from_pretrained>[1]);
  } else if (m.kind === "sam2") {
    const model = await tf.Sam2Model.from_pretrained(m.id, { dtype: m.dtype });
    await tf.AutoProcessor.from_pretrained(m.id);
    await model.dispose();
  } else {
    const p = await tf.pipeline("zero-shot-object-detection", m.id, { dtype: m.dtype });
    await p.dispose();
  }
}

/**
 * Download every model into `dir`, laid out as `bundledModelsDir` reads it, then load each one from
 * there with downloads switched off: a model that loads that way loads in the installed app.
 */
export async function downloadBundledModels(dir: string, log: (line: string) => void = () => {}): Promise<void> {
  for (const { folder, model, use } of FILE_MODELS) {
    log(`${use}: ${folder}/${model.file}`);
    await retried(model.file, log, () => ensureModelFile({ modelsDir: dir }, folder, model));
  }
  const tf = await import("@huggingface/transformers");
  // Download into `dir` only: no reading from another local folder.
  tf.env.cacheDir = dir;
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;
  for (const m of TRANSFORMERS_MODELS) {
    log(`${m.use}: ${m.id}`);
    await retried(m.id, log, () => loadTransformersModel(m));
  }
  // The check: everything from `dir` as the installed app reads it, nothing from the network.
  log("Checking every model loads from the folder alone");
  tf.env.cacheDir = path.join(dir, ".no-cache");
  tf.env.localModelPath = dir.endsWith(path.sep) ? dir : dir + path.sep;
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = false;
  try {
    for (const m of TRANSFORMERS_MODELS) await loadTransformersModel(m);
  } finally {
    await rm(path.join(dir, ".no-cache"), { recursive: true, force: true });
  }
}
