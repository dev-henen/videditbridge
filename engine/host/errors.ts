import { AGENT_MODELS, providerInfo, providerOf } from "./models.js";

/**
 * A provider's failure as one plain sentence for the chat. The SDKs report errors as status codes
 * with JSON bodies, and Google nests its JSON inside a string; people should read what happened and
 * what to do, not that.
 */

/** Every "message" in an error's text, innermost last, unescaped (Google nests JSON in strings). */
function messagesIn(text: string): string[] {
  const out: string[] = [];
  let t = text;
  for (let depth = 0; depth < 4; depth++) {
    const found = [...t.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    if (!found.length) break;
    const unescaped = found.map((s) => {
      try {
        return JSON.parse(`"${s}"`) as string;
      } catch {
        return s;
      }
    });
    out.push(...unescaped);
    t = unescaped.join("\n");
  }
  return out;
}

/** The status code: from the error object, else from its text. */
function statusOf(e: unknown, text: string): number | undefined {
  const o = e as { status?: unknown; code?: unknown };
  for (const v of [o?.status, o?.code]) if (typeof v === "number" && v >= 100 && v < 600) return v;
  const m = text.match(/\\*"code\\*"\s*:\s*(\d{3})/) ?? text.match(/^\s*(\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}

/** The first sentence of the most readable message, short. */
function shortest(text: string): string {
  const readable = messagesIn(text)
    .map((m) => m.trim())
    .filter((m) => m && !m.startsWith("{"));
  const first = (readable[readable.length - 1] ?? text.replace(/[{}"\\]/g, " ")).replace(/\s+/g, " ").trim();
  const sentence = first.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? first;
  return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence;
}

/** What went wrong in a request to a model, in a sentence that says what to do. */
export function describeAgentError(e: unknown, model: string): string {
  const text = e instanceof Error ? e.message : String(e);
  const info = providerInfo(providerOf(model));
  const who = info.label;
  const label = AGENT_MODELS.find((m) => m.id === model)?.label ?? model;
  const status = statusOf(e, text);
  const lower = text.toLowerCase();
  const cause = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;

  if (typeof cause === "string" && /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(cause)) return `Could not reach ${who}. Check the internet connection, then try again.`;
  if (/fetch failed|network|socket hang up|getaddrinfo/.test(lower) && !status) return `Could not reach ${who}. Check the internet connection, then try again.`;

  if (status === 429 || /resource_exhausted|rate.?limit|quota/.test(lower)) {
    const wait = text.match(/retryDelay\\*"\s*:\s*\\*"(\d+(?:\.\d+)?)s/)?.[1] ?? text.match(/retry after (\d+)/i)?.[1];
    const free = /free.?tier/i.test(text) ? ", the free tier's limit" : "";
    const when = wait ? `Try again in ${Math.max(1, Math.ceil(Number(wait)))} seconds` : "Wait a minute and try again";
    return `${who} says this key has hit its usage limit${free}. ${when}, or check your plan at ${info.keyUrl}.`;
  }
  if (status === 401 || status === 403 || /api key|invalid.*key|permission_denied|unauthenticated/.test(lower))
    return `${who} did not accept the API key. Check it in Settings (or add a new one), then try again.`;
  if (status === 404 || /not_found|model.*(not found|does not exist|is not supported)/.test(lower)) return `${label} is not available with this key. Pick another model in the chat.`;
  if (/context|too long|maximum.*tokens|token limit/.test(lower) && (status === 400 || status === 413))
    return `This conversation has grown too long for ${label}. Start a new conversation to go on.`;
  if (status === 529 || status === 503 || /overloaded|unavailable/.test(lower)) return `${who} is busy right now. Try again in a moment.`;
  if (status !== undefined && status >= 500) return `${who} had a problem on its side. Try again in a moment.`;
  if (status === 400) return `${who} could not take this request: ${shortest(text)}`;
  return shortest(text) || `Something went wrong talking to ${who}. Try again.`;
}
