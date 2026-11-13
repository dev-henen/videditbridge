/**
 * The preview view the Claude and ChatGPT apps show inside the chat (MCP Apps, `ui://` resource):
 * it plays the preview a render_preview call made, or shows the frame or contact sheet. It speaks
 * the MCP Apps postMessage protocol (JSON-RPC 2.0 with the host): `ui/initialize`, then
 * `ui/notifications/initialized`; it gets the call's result in `ui/notifications/tool-result`, reads
 * the file it names (result `_meta["ai-video-editor/media"]`) with the server's `fetch_media` tool,
 * and shows it as a data: URL (the only media source the hosts allow by default). It reports its
 * size with `ui/notifications/size-changed`.
 */
export const PREVIEW_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video preview</title>
<style>
  :root { --bg: #121212; --panel: #1c1c1c; --text: #ededed; --muted: #8c8c8c; --accent: #3b82f6; --error: #f87171; }
  :root[data-theme="light"] { --bg: #ffffff; --panel: #f3f4f6; --text: #18181b; --muted: #6b7280; --accent: #2563eb; --error: #dc2626; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Inter, sans-serif; }
  main { padding: 10px; }
  .stage { background: #000; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; min-height: 120px; }
  video, img { display: block; width: 100%; height: auto; max-height: 70vh; object-fit: contain; }
  .caption { margin-top: 8px; display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .note { padding: 18px; color: var(--muted); text-align: center; }
  .error { color: var(--error); }
</style>
</head>
<body>
<main>
  <div class="stage" id="stage"><div class="note" id="note">Waiting for the render</div></div>
  <div class="caption" id="caption" hidden><span class="dot"></span><span id="captionText"></span></div>
</main>
<script>
(() => {
  const MEDIA_META = "ai-video-editor/media";
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage(msg, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ jsonrpc: "2.0", id, method, params });
  });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params });

  const stage = document.getElementById("stage");
  const caption = document.getElementById("caption");
  const captionText = document.getElementById("captionText");
  const note = (text, isError) => {
    stage.replaceChildren(Object.assign(document.createElement("div"), { className: "note" + (isError ? " error" : ""), textContent: text }));
  };
  const applyTheme = (ctx) => {
    if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  };

  // The result's first line, without the file path at its end.
  const describe = (result) => {
    const text = ((result.content || []).find((c) => c.type === "text") || {}).text || "";
    return text.split("\\n")[0].replace(/:\\s*\\S*[\\\\/]\\S*$/, "").trim();
  };

  async function show(result) {
    if (result.isError) return note(describe(result) || "The render failed.", true);
    const media = result._meta && result._meta[MEDIA_META];
    captionText.textContent = describe(result);
    caption.hidden = !captionText.textContent;
    if (!media) return note("Nothing to show for this call.");
    note(media.mimeType.startsWith("video/") ? "Loading the preview" : "Loading the picture");
    try {
      const r = await request("tools/call", { name: "fetch_media", arguments: { path: media.path } });
      if (r.isError || !r.structuredContent) throw new Error(((r.content || [])[0] || {}).text || "Could not load the render.");
      const { mimeType, data } = r.structuredContent;
      const src = "data:" + mimeType + ";base64," + data;
      const el = mimeType.startsWith("video/")
        ? Object.assign(document.createElement("video"), { src, controls: true, autoplay: true, muted: true, loop: true, playsInline: true })
        : Object.assign(document.createElement("img"), { src, alt: captionText.textContent || "Rendered frame" });
      stage.replaceChildren(el);
    } catch (e) {
      note(String(e && e.message ? e.message : e), true);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "Request failed"));
      else p.resolve(msg.result);
      return;
    }
    switch (msg.method) {
      case "ui/notifications/tool-result":
        show(msg.params || {});
        break;
      case "ui/notifications/tool-cancelled":
        note("The render was stopped.");
        break;
      case "ui/notifications/host-context-changed":
        applyTheme(msg.params);
        break;
      case "ui/resource-teardown":
        post({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      default:
        // A request this view does not handle still gets an answer.
        if (msg.id !== undefined && msg.method) post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  new ResizeObserver(() => {
    const r = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }).observe(document.documentElement);

  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "AI Video Editor preview", version: "1" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } })
    .then((r) => {
      applyTheme(r && r.hostContext);
      notify("ui/notifications/initialized", {});
    })
    .catch(() => notify("ui/notifications/initialized", {}));
})();
</script>
</body>
</html>
`;
