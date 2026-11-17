import { TOOLS, toAnthropicTools, type ToolDefinition } from "../claude/tools.js";
import type { AgentMessage, ContentBlock, ToolSpec } from "./providers.js";

/**
 * Which tools the agent sends with each request. Every request carries the whole tool list, and
 * all 121 tools come to about 45,000 tokens, which is most of what a step costs and more than free
 * tiers allow in a minute. So a request carries the core tools for everyday edits, plus load_tools
 * and a one-line list of the rest (in the system prompt); the model loads a tool by name when it
 * needs it, and from then on the conversation keeps it. The list only grows, at its end, so the
 * providers' caches of the prompt start stay valid.
 *
 * Only the app's own agent works this way. MCP clients get every tool (engine/mcp/server.ts).
 */

/** Tools every request carries: what casual editing of talking footage, music and titles needs. */
export const CORE_TOOLS: readonly string[] = [
  "get_project",
  "import_media",
  "undo",
  "redo",
  "add_clip",
  "update_clip",
  "remove_clip",
  "move_clip",
  "split_clip",
  "trim_clip",
  "cut_ranges",
  "set_transition",
  "list_transitions",
  "add_effect",
  "remove_effect",
  "list_effects",
  "add_text",
  "update_layer",
  "remove_layer",
  "add_audio",
  "update_audio",
  "set_volume",
  "transcribe",
  "get_transcript",
  "search_transcript",
  "cleanup_speech",
  "remove_silences",
  "set_captions",
  "list_caption_styles",
  "render_frame",
  "render_contact_sheet",
  "render_preview",
  "render_video",
  "search_files",
  "copy_to_project",
  "offer_choices",
  "propose_plan",
  "remember",
];

export const LOAD_TOOLS = "load_tools";

const LOAD_TOOLS_SPEC: ToolSpec = {
  name: LOAD_TOOLS,
  description:
    "Make more tools available: give the names of tools from the list of more tools in your instructions. They can be called from your next step on, for the rest of the conversation. Load all the tools a task needs in one call.",
  input_schema: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" }, minItems: 1, description: "Tool names, e.g. ['detect_beats', 'beat_sync']" } },
    required: ["names"],
  },
};

const byName = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

/** The tools outside the core, one line each: name and the first sentence of what it does. */
export function moreToolsList(): string {
  const lines = TOOLS.filter((t) => !CORE_TOOLS.includes(t.name)).map((t) => {
    const first = t.description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t.description;
    return `- ${t.name}: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}`;
  });
  return `More tools (call ${LOAD_TOOLS} with their names to use them; the instructions above name some of them):\n${lines.join("\n")}`;
}

/** Each tool's spec, made once (the JSON Schema conversion is not free and the specs never change). */
const specs = new Map<string, ToolSpec>();
function specOf(t: ToolDefinition): ToolSpec {
  let s = specs.get(t.name);
  if (!s) specs.set(t.name, (s = toAnthropicTools([t])[0]!));
  return s;
}

export class ToolSet {
  /** Tools loaded beyond the core, in the order they were loaded. */
  private readonly loaded: string[] = [];

  /** A conversation that already used tools keeps them, since its history refers to them. */
  constructor(history: readonly AgentMessage[] = []) {
    for (const m of history) {
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      for (const b of m.content as ContentBlock[]) if (b.type === "tool_use") this.add(b.name);
    }
  }

  /** Whether a tool is in the list the model sees now. */
  has(name: string): boolean {
    return name === LOAD_TOOLS || CORE_TOOLS.includes(name) || this.loaded.includes(name);
  }

  /** Add a tool (a known one outside the core); true when it was not there yet. */
  add(name: string): boolean {
    if (!byName.has(name) || this.has(name)) return false;
    this.loaded.push(name);
    return true;
  }

  /** The specs to send: core, then loaded tools, then load_tools. Plan mode leaves out tools that change the project. */
  specs(planMode = false): ToolSpec[] {
    const names = [...CORE_TOOLS, ...this.loaded];
    const defs = names.map((n) => byName.get(n)).filter((t): t is ToolDefinition => !!t && !(planMode && t.mutates));
    return [...defs.map(specOf), LOAD_TOOLS_SPEC];
  }

  /** Run load_tools: load the known names and say what happened. */
  load(input: unknown): { text: string; isError?: boolean } {
    const names = (input as { names?: unknown })?.names;
    if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string")) return { text: "Give names: a list of tool names.", isError: true };
    const unknown = names.filter((n) => !byName.has(n));
    const added = names.filter((n) => this.add(n));
    const already = names.filter((n) => byName.has(n) && !added.includes(n));
    const parts = [
      added.length ? `Loaded ${added.join(", ")}; call them from your next step.` : "",
      already.length ? `Already available: ${already.join(", ")}.` : "",
      unknown.length ? `No such tools: ${unknown.join(", ")}. Use names from the list of more tools.` : "",
    ].filter(Boolean);
    return { text: parts.join(" "), isError: !added.length && !already.length };
  }
}
