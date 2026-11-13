/**
 * The AI providers and models the app can edit with. Claude (Anthropic) is the default; ChatGPT
 * (OpenAI) and Gemini (Google) work the same way through the same editing tools. This file holds
 * only names and ids, so settings can use it without loading the providers' SDKs.
 */

export type ProviderId = "anthropic" | "openai" | "google";

export interface ProviderInfo {
  id: ProviderId;
  /** The company, for the Settings tab ("Anthropic"). */
  label: string;
  /** What the app calls the assistant ("Claude"). */
  assistant: string;
  /** Environment variables that give the key, the first being the one the host sets. */
  keyEnv: readonly string[];
  /** Where to get a key. */
  keyUrl: string;
  /** What a key looks like, for the key box. */
  keyHint: string;
}

/** The providers, the first being the default. */
export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", assistant: "Claude", keyEnv: ["ANTHROPIC_API_KEY"], keyUrl: "console.anthropic.com", keyHint: "sk-ant-..." },
  { id: "openai", label: "OpenAI", assistant: "ChatGPT", keyEnv: ["OPENAI_API_KEY"], keyUrl: "platform.openai.com", keyHint: "sk-..." },
  { id: "google", label: "Google", assistant: "Gemini", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], keyUrl: "aistudio.google.com", keyHint: "AIza..." },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as readonly ProviderId[];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id)!;

export interface AgentModel {
  id: string;
  provider: ProviderId;
  label: string;
  description: string;
}

/** Models the app offers, grouped by provider; the first is the default. */
export const AGENT_MODELS: readonly AgentModel[] = [
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", description: "Most capable, for full edits" },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", description: "Fast and capable" },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", description: "Fastest, for small changes" },
  { id: "gpt-6-astra", provider: "openai", label: "GPT-6 Astra", description: "OpenAI's most capable" },
  { id: "gpt-6.1-sol", provider: "openai", label: "GPT-6.1 Sol", description: "OpenAI, fast and capable" },
  { id: "gpt-6-luna", provider: "openai", label: "GPT-6 Luna", description: "OpenAI's fastest, for small changes" },
  { id: "gemini-4-carbon", provider: "google", label: "Gemini 4 Carbon", description: "Google's most capable" },
  { id: "gemini-4-hydrogen", provider: "google", label: "Gemini 4 Hydrogen", description: "Google, fast and capable" },
  { id: "gemini-3.5-flash-lite", provider: "google", label: "Gemini 3.5 Flash-Lite", description: "Google's fastest, for small changes" },
];
export const DEFAULT_MODEL = AGENT_MODELS[0]!.id;

/**
 * The provider of a model id: a listed model's, else by its name (so a newer model id from the same
 * family still works), else Anthropic.
 */
export function providerOf(model: string): ProviderId {
  const listed = AGENT_MODELS.find((m) => m.id === model);
  if (listed) return listed.provider;
  if (/^(gpt-|o\d|chatgpt-)/i.test(model)) return "openai";
  if (/^gemini-/i.test(model)) return "google";
  return "anthropic";
}

/** The assistant's name for a model ("Claude", "ChatGPT", "Gemini"). */
export const assistantOf = (model: string): string => providerInfo(providerOf(model)).assistant;

/** The key the environment gives a provider, if any. */
export function envKeyOf(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of providerInfo(id).keyEnv) if (env[name]) return env[name];
  return undefined;
}

/** Whether a provider can be used now (a key in the environment; for Anthropic also a token or profile). */
export function providerAvailable(id: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envKeyOf(id, env)) return true;
  return id === "anthropic" && !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
