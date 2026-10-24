/**
 * ai-video-editor — an AI-native video editing library.
 *
 *  core/     the Project document, timeline math, pure edit operations, validation, summaries
 *  library/  effects, transitions, animations, caption styles, components, templates
 *  tools/    transcripts, captions, voice-over, FFmpeg rendering, live preview
 *  claude/   editing session + tool definitions for Claude (Messages API / future MCP connector)
 */
export * from "./core/index.js";
export * from "./library/index.js";
export * from "./tools/index.js";
export * from "./claude/index.js";
