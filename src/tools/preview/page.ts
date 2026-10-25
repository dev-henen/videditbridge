/** Self-contained live preview UI served by the preview server. */
export const PREVIEW_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video Edit Preview</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --line: #2a2f3a; --text: #e7e9ee; --muted: #8b93a7;
    --accent: #7c5cff; --ok: #3ccf91; --warn: #f5b942; --err: #ff5c7a;
    --clip: #3b82f6; --text-layer: #f59e0b; --media-layer: #10b981; --shape-layer: #a855f7; --audio: #ec4899; --caption: #64748b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .pill { font-size: 12px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); padding: 2px 8px; border-radius: 999px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); display: inline-block; }
  .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .spacer { flex: 1; }
  button { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; padding: 16px; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-width: 0; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .viewer { display: flex; flex-direction: column; gap: 10px; }
  .stage { background: #000; border-radius: 8px; display: flex; align-items: center; justify-content: center; min-height: 320px; max-height: 62vh; overflow: hidden; position: relative; }
  .stage img, .stage video { max-width: 100%; max-height: 62vh; display: block; }
  .stage .loading { position: absolute; top: 8px; right: 8px; font-size: 12px; background: rgba(0,0,0,.6); padding: 2px 8px; border-radius: 6px; display: none; }
  .stage.busy .loading { display: block; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .controls input[type=range] { flex: 1; min-width: 160px; accent-color: var(--accent); }
  .tabs { display: flex; gap: 4px; }
  .tabs button.active { border-color: var(--accent); color: #fff; }
  .timeline { position: relative; margin-top: 4px; user-select: none; }
  .ruler { position: relative; height: 18px; margin-left: 84px; border-bottom: 1px solid var(--line); font-size: 10px; color: var(--muted); }
  .ruler span { position: absolute; transform: translateX(-50%); }
  .track { display: flex; align-items: stretch; min-height: 26px; border-bottom: 1px solid var(--line); }
  .track .name { width: 84px; flex: none; font-size: 11px; color: var(--muted); padding: 5px 6px 0 0; text-align: right; }
  .track .lane { position: relative; flex: 1; }
  .block { position: absolute; top: 3px; height: 20px; border-radius: 4px; font-size: 11px; padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; cursor: pointer; border: 1px solid rgba(255,255,255,.15); }
  .block.clip { background: var(--clip); } .block.text { background: var(--text-layer); color: #111; } .block.media { background: var(--media-layer); }
  .block.shape { background: var(--shape-layer); } .block.music, .block.voiceover, .block.sfx { background: var(--audio); } .block.caption { background: var(--caption); font-size: 10px; }
  .block .tr { position: absolute; left: 0; top: 0; bottom: 0; background: repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, transparent 4px 8px); }
  .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; pointer-events: none; margin-left: 84px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: #c9cede; max-height: 360px; overflow: auto; }
  ul.list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow: auto; }
  ul.list li { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; display: flex; gap: 8px; }
  ul.list li time { color: var(--muted); font-size: 11px; flex: none; width: 64px; }
  .issue.error { color: var(--err); } .issue.warning { color: var(--warn); }
  .renders { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 8px; }
  .renders a { display: block; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 6px; font-size: 11px; color: var(--muted); text-decoration: none; }
  .renders a.stale { opacity: .5; }
  .renders img { width: 100%; height: 60px; object-fit: cover; border-radius: 4px; display: block; margin-bottom: 4px; }
  .side { display: flex; flex-direction: column; gap: 16px; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--err); color: #fff; padding: 8px 14px; border-radius: 8px; display: none; max-width: 90vw; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
</style>
</head>
<body>
<header>
  <span class="dot" id="live" title="Live connection"></span>
  <h1 id="name">Connecting…</h1>
  <span class="pill" id="meta"></span>
  <span class="pill" id="rev"></span>
  <span class="spacer"></span>
  <button id="undo">Undo</button>
  <button id="redo">Redo</button>
  <button id="sheet">Contact sheet</button>
  <button id="preview" class="primary">Render preview video</button>
</header>
<main>
  <div class="viewer">
    <section>
      <div class="controls" style="margin-bottom:10px">
        <div class="tabs">
          <button data-view="frame" class="active">Frame</button>
          <button data-view="sheet">Contact sheet</button>
          <button data-view="video">Video</button>
        </div>
        <input type="range" id="scrub" min="0" max="1" step="0.05" value="0">
        <span class="pill" id="time">0.0s</span>
      </div>
      <div class="stage" id="stage"><div class="empty">Waiting for the first edit…</div><span class="loading">rendering…</span></div>
    </section>
    <section>
      <h2>Timeline</h2>
      <div class="timeline" id="timeline"></div>
    </section>
    <section>
      <h2>Renders</h2>
      <div class="renders" id="renders"></div>
    </section>
  </div>
  <div class="side">
    <section><h2>Issues</h2><ul class="list" id="issues"></ul></section>
    <section><h2>Edit history</h2><ul class="list" id="history"></ul></section>
    <section><h2>Summary</h2><pre id="summary"></pre></section>
    <section><h2>Log</h2><ul class="list" id="log"></ul></section>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var state = null, view = "frame", time = 0, frameTimer = null;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(t) { var m = Math.floor(t / 60), s = (t % 60).toFixed(1); return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
  function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function toast(msg) { var t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = "none"; }, 6000); }

  function latest(kind) {
    if (!state) return null;
    for (var i = 0; i < state.renders.length; i++) if (state.renders[i].kind === kind) return state.renders[i];
    return null;
  }

  function showStage() {
    var stage = $("stage");
    var html = "";
    if (!state || state.duration <= 0) html = '<div class="empty">' + (state && state.timelineError ? esc(state.timelineError) : "Nothing to show yet, add clips, layers or apply a template.") + "</div>";
    else if (view === "frame") html = '<img id="frameImg" alt="Frame preview">';
    else if (view === "sheet") {
      var s = latest("contact-sheet");
      html = s ? '<img alt="Contact sheet" src="' + s.url + '">' : '<div class="empty">No contact sheet yet.</div>';
    } else {
      var v = latest("preview") || latest("video");
      html = v ? '<video controls autoplay src="' + v.url + '"></video>' : '<div class="empty">No preview video yet, click “Render preview video”.</div>';
    }
    stage.innerHTML = html + '<span class="loading">rendering…</span>';
    if (view === "frame" && state && state.duration > 0) loadFrame();
  }

  function loadFrame() {
    clearTimeout(frameTimer);
    frameTimer = setTimeout(function () {
      var img = $("frameImg"); if (!img) return;
      var stage = $("stage"); stage.classList.add("busy");
      var t = Math.min(time, Math.max(0, state.duration - 0.05));
      var next = new Image();
      next.onload = function () { stage.classList.remove("busy"); var cur = $("frameImg"); if (cur) cur.src = next.src; };
      next.onerror = function () { stage.classList.remove("busy"); toast("Frame render failed"); };
      next.src = "/api/frame?t=" + t.toFixed(2) + "&rev=" + state.revision;
    }, 250);
  }

  function block(cls, start, end, label, title, extra) {
    var d = state.duration || 1;
    return '<div class="block ' + cls + '" style="left:' + (start / d * 100) + "%;width:" + Math.max(0.3, (end - start) / d * 100) + '%" title="' + esc(title) + '" data-t="' + start + '">' + (extra || "") + esc(label) + "</div>";
  }

  function lanesFor(items) {
    var lanes = [];
    items.forEach(function (it) {
      for (var i = 0; i < lanes.length; i++) { var last = lanes[i][lanes[i].length - 1]; if (last.end <= it.start + 0.001) { lanes[i].push(it); return; } }
      lanes.push([it]);
    });
    return lanes;
  }

  function renderTimeline() {
    var el = $("timeline"), d = state.duration;
    if (!d) { el.innerHTML = '<div class="empty">Empty timeline</div>'; return; }
    var html = '<div class="ruler">';
    var step = d > 300 ? 60 : d > 120 ? 30 : d > 40 ? 10 : d > 15 ? 5 : 1;
    for (var t = 0; t <= d + 0.001; t += step) html += '<span style="left:' + (t / d * 100) + '%">' + fmt(t) + "</span>";
    html += "</div>";
    html += '<div class="track"><div class="name">Primary</div><div class="lane">' + state.clips.map(function (c) {
      var tr = c.transition ? '<span class="tr" style="width:' + (c.transition.duration / (c.end - c.start) * 100) + '%"></span>' : "";
      return block("clip", c.start, c.end, (c.label || c.assetId), c.id + " · " + c.assetId + (c.transition ? " · transition " + c.transition.type : "") + (c.effects.length ? " · fx: " + c.effects.join(", ") : ""), tr);
    }).join("") + "</div></div>";
    lanesFor(state.layers.slice().sort(function (a, b) { return a.start - b.start; })).forEach(function (lane, i) {
      html += '<div class="track"><div class="name">' + (i === 0 ? "Layers" : "") + '</div><div class="lane">' + lane.map(function (l) {
        return block(l.type, l.start, l.end, l.label, l.id + " (" + l.type + ")" + (l.group ? " · " + l.group : "") + ": " + l.label);
      }).join("") + "</div></div>";
    });
    lanesFor(state.audio.slice().sort(function (a, b) { return a.start - b.start; })).forEach(function (lane, i) {
      html += '<div class="track"><div class="name">' + (i === 0 ? "Audio" : "") + '</div><div class="lane">' + lane.map(function (a) {
        return block(a.role, a.start, a.end, a.role + " · " + a.assetId, a.id);
      }).join("") + "</div></div>";
    });
    if (state.captions.length) {
      html += '<div class="track"><div class="name">Captions</div><div class="lane">' + state.captions.map(function (c) { return block("caption", c.start, c.end, c.text, c.text); }).join("") + "</div></div>";
    }
    html += '<div class="playhead" id="playhead"></div>';
    el.innerHTML = html;
    placePlayhead();
  }

  function placePlayhead() {
    var ph = $("playhead"); if (!ph || !state.duration) return;
    var lane = document.querySelector(".lane"); if (!lane) return;
    ph.style.left = (time / state.duration * lane.clientWidth) + "px";
  }

  function render() {
    $("name").textContent = state.name;
    $("meta").textContent = state.settings.width + "×" + state.settings.height + " · " + state.settings.fps + "fps · " + state.duration.toFixed(1) + "s";
    $("rev").textContent = "rev " + state.revision;
    $("undo").disabled = !state.canUndo; $("redo").disabled = !state.canRedo;
    var scrub = $("scrub"); scrub.max = Math.max(0.05, state.duration); if (time > state.duration) time = 0; scrub.value = time;
    $("time").textContent = fmt(time);
    $("summary").textContent = state.summary;
    $("issues").innerHTML = state.issues.length ? state.issues.map(function (i) { return '<li class="issue ' + i.level + '">' + (i.level === "error" ? "✗ " : "⚠ ") + esc(i.path) + ": " + esc(i.message) + "</li>"; }).join("") : '<li style="color:var(--ok)">✓ No issues</li>';
    $("history").innerHTML = state.history.map(function (h) { return "<li><time>" + clock(h.at) + "</time><span>" + esc(h.action) + "</span></li>"; }).join("") || '<li style="color:var(--muted)">No edits yet</li>';
    $("log").innerHTML = state.log.map(function (l) { return '<li class="issue ' + (l.level === "error" ? "error" : "") + '"><time>' + clock(l.at) + "</time><span>" + esc(l.message) + "</span></li>"; }).join("") || '<li style="color:var(--muted)">-</li>';
    $("renders").innerHTML = state.renders.map(function (r) {
      var thumb = r.kind === "preview" || r.kind === "video" ? "" : '<img src="' + r.url + '" alt="">';
      return '<a target="_blank" class="' + (r.stale ? "stale" : "") + '" href="' + r.url + '" title="' + (r.stale ? "From an older revision" : "Current") + '">' + thumb + esc(r.kind) + (r.time != null ? " @" + r.time + "s" : "") + "<br>" + clock(r.at) + "</a>";
    }).join("") || '<span style="color:var(--muted)">Nothing rendered yet.</span>';
    renderTimeline();
    showStage();
  }

  function connect() {
    var es = new EventSource("/events");
    es.addEventListener("open", function () { $("live").classList.add("live"); });
    es.addEventListener("state", function (e) { state = JSON.parse(e.data); render(); });
    es.addEventListener("error", function (e) {
      if (e.data) { try { toast(JSON.parse(e.data).message); } catch (x) {} return; }
      $("live").classList.remove("live");
    });
  }

  function post(url, btn, label) {
    btn.disabled = true; var old = btn.textContent; btn.textContent = label;
    fetch(url, { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) { if (j.error) toast(j.error); })
      .catch(function (e) { toast(String(e)); }).finally(function () { btn.disabled = false; btn.textContent = old; });
  }

  document.querySelectorAll(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active"); view = b.getAttribute("data-view"); showStage();
    });
  });
  $("scrub").addEventListener("input", function (e) {
    time = Number(e.target.value); $("time").textContent = fmt(time); placePlayhead();
    if (view !== "frame") { view = "frame"; document.querySelector('.tabs button[data-view="frame"]').click(); } else loadFrame();
  });
  $("timeline").addEventListener("click", function (e) {
    var lane = document.querySelector(".lane"); if (!lane || !state) return;
    var rect = lane.getBoundingClientRect();
    var x = e.clientX - rect.left; if (x < 0) return;
    time = Math.max(0, Math.min(state.duration, x / rect.width * state.duration));
    $("scrub").value = time; $("time").textContent = fmt(time); placePlayhead();
    if (view !== "frame") document.querySelector('.tabs button[data-view="frame"]').click(); else loadFrame();
  });
  $("undo").addEventListener("click", function () { post("/api/undo", $("undo"), "…"); });
  $("redo").addEventListener("click", function () { post("/api/redo", $("redo"), "…"); });
  $("sheet").addEventListener("click", function () { post("/api/contact-sheet", $("sheet"), "Rendering…"); });
  $("preview").addEventListener("click", function () {
    post("/api/preview", $("preview"), "Rendering…");
    document.querySelector('.tabs button[data-view="video"]').click();
  });
  window.addEventListener("resize", placePlayhead);
  connect();
})();
</script>
</body>
</html>`;
