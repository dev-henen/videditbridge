#!/usr/bin/env node
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseProject, type Project } from "./core/schema.js";
import { validateProject } from "./core/validate.js";
import { summarizeProject } from "./core/summary.js";
import { describeTemplate, getTemplate, listTemplates } from "./library/templates/index.js";
import { exportCaptions, type CaptionExportFormat } from "./tools/captions/build.js";
import { probe } from "./tools/render/ffmpeg.js";
import { render, renderContactSheet, renderFrame } from "./tools/render/render.js";
import { startPreviewServer } from "./tools/preview/server.js";
import { EditorSession } from "./claude/session.js";
import { toAnthropicTools } from "./claude/tools.js";

const HELP = `ave — AI video editor CLI

Usage:
  ave templates [query]                    List templates (optionally filtered)
  ave template <id> [--json]               Show a template brief (or its JSON spec)
  ave validate <project.json>              Check a project for problems
  ave summary <project.json>               Human/AI-readable summary of an edit
  ave render <project.json> <out.mp4>      Render a video  [--scale 0.5] [--preset ultrafast] [--start s --end s]
  ave frame <project.json> <time> <out.png>  Render one frame [--scale 0.5]
  ave sheet <project.json> <out.png>       Render a contact sheet [--columns 4 --rows 3]
  ave captions <project.json> <out.srt|vtt|ass>  Export captions
  ave preview <project.json> [--port 4321] Live preview that reloads when the file changes
  ave probe <media>                        Inspect a media file
  ave tools                                Print Claude tool definitions (JSON)

Relative media paths in a project resolve against the project file's folder.`;

async function loadProject(file: string): Promise<{ project: Project; baseDir: string }> {
  const raw = JSON.parse(await readFile(file, "utf8"));
  return { project: parseProject(raw), baseDir: path.dirname(path.resolve(file)) };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scale: { type: "string" },
      preset: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      columns: { type: "string" },
      rows: { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
      fonts: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  if (!cmd || values.help) {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case "templates": {
      for (const t of listTemplates({ query: args.join(" ") || undefined }))
        console.log(`${t.id.padEnd(26)} ${t.aspectRatio.padEnd(5)} ${t.category.padEnd(13)} ${t.name}`);
      return 0;
    }
    case "template": {
      const t = getTemplate(args[0] ?? "");
      if (!t) throw new Error(`Unknown template "${args[0]}"`);
      console.log(values.json ? JSON.stringify(t, null, 2) : describeTemplate(t));
      return 0;
    }
    case "validate": {
      const raw = JSON.parse(await readFile(args[0]!, "utf8"));
      const r = validateProject(raw);
      for (const i of r.issues) console.log(`${i.level === "error" ? "✗" : "⚠"} ${i.path}: ${i.message}`);
      console.log(r.ok ? "✓ valid" : "✗ invalid");
      return r.ok ? 0 : 1;
    }
    case "summary": {
      console.log(summarizeProject((await loadProject(args[0]!)).project));
      return 0;
    }
    case "render": {
      const { project, baseDir } = await loadProject(args[0]!);
      const start = num(values.start);
      const end = num(values.end);
      let last = -1;
      const r = await render(project, {
        output: args[1]!,
        baseDir,
        scale: num(values.scale),
        preset: values.preset,
        fontsDir: values.fonts,
        range: start !== undefined || end !== undefined ? { start: start ?? 0, end: end ?? Number.MAX_SAFE_INTEGER } : undefined,
        onProgress: (p) => {
          const pct = Math.floor(p * 100);
          if (pct !== last && pct % 5 === 0) process.stderr.write(`\rRendering… ${pct}%`);
          last = pct;
        },
      });
      process.stderr.write("\n");
      console.log(`✓ ${r.output} (${r.duration}s)`);
      return 0;
    }
    case "frame": {
      const { project, baseDir } = await loadProject(args[0]!);
      console.log(await renderFrame(project, Number(args[1]), { output: args[2]!, baseDir, scale: num(values.scale), fontsDir: values.fonts }));
      return 0;
    }
    case "sheet": {
      const { project, baseDir } = await loadProject(args[0]!);
      console.log(await renderContactSheet(project, { output: args[1]!, baseDir, columns: num(values.columns), rows: num(values.rows), fontsDir: values.fonts }));
      return 0;
    }
    case "captions": {
      const { project } = await loadProject(args[0]!);
      const out = args[1]!;
      const format = path.extname(out).slice(1) as CaptionExportFormat;
      await writeFile(out, exportCaptions(project, format), "utf8");
      console.log(`✓ ${out}`);
      return 0;
    }
    case "probe": {
      console.log(JSON.stringify(await probe(args[0]!), null, 2));
      return 0;
    }
    case "tools": {
      console.log(JSON.stringify(toAnthropicTools(), null, 2));
      return 0;
    }
    case "preview": {
      const file = path.resolve(args[0]!);
      const { project, baseDir } = await loadProject(file);
      const session = new EditorSession(project, { baseDir, fontsDir: values.fonts });
      const server = await startPreviewServer(session, { port: num(values.port) ?? 4321 });
      console.log(`Live preview: ${server.url}\nWatching ${file} — save the file to update. Ctrl+C to stop.`);
      let timer: NodeJS.Timeout | undefined;
      watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const next = (await loadProject(file)).project;
            session.commit(next, "file changed");
            session.info(`Reloaded ${path.basename(file)}`);
          } catch (e) {
            session.error(`Could not load ${path.basename(file)}: ${(e as Error).message.split("\n")[0]}`);
          }
        }, 200);
      });
      await new Promise(() => undefined);
      return 0;
    }
    default:
      console.error(`Unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
