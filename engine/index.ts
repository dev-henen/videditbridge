/**
 * ai-video-editor: an AI-native video editing library.
 *
 *  core/     the Project document, timeline math, pure edit operations, validation, summaries
 *  library/  effects, transitions, animations, caption styles, components, templates
 *  tools/    transcripts, captions, voice-over, FFmpeg rendering, review, vision, graphics
 *  claude/   editing session + tool definitions for Claude (Messages API, and the MCP server in mcp/)
 */
export * from "./core/index.js";
export * from "./library/index.js";
export * from "./tools/index.js";
export * from "./claude/index.js";
