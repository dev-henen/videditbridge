#!/usr/bin/env node
/**
 * Build the user guide website (GitHub Pages) into site/_site.
 *
 *   node scripts/build-site.mjs        (also: npm run site)
 *
 * Each page in site/pages/*.html is the content only; this wraps it in the shared layout (top bar,
 * side menu, previous and next, footer), gives code blocks a copy button, and makes the tools page
 * from docs/reference/tools.json (written by `npm run docs` from the live tool list). Plain Node, no
 * packages, so the Pages workflow needs no install.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "site");
const out = path.join(src, "_site");
const REPO = "https://github.com/dev-henen/videditbridge";

const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  home: icon('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>'),
  key: icon('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2"/><path d="m16 7 3 3"/>'),
  plug: icon('<path d="M9 7V3"/><path d="M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/>'),
  chat: icon('<path d="M4 5h16v11H9l-5 4Z"/>'),
  tools: icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  help: icon('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5h.01"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  menu: icon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  github: icon('<path d="M9 19c-4 1.5-4-2-6-2.5m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.3 5.8 2.6 5.8 2.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2v3.5"/>'),
};

/** The pages, in reading order, with the side menu's sections. */
const PAGES = [
  { file: "index.html", title: "Getting started", icon: "home", section: "Start here" },
  { file: "api-keys.html", title: "API keys", icon: "key", section: "Start here" },
  { file: "claude-app.html", title: "Use the Claude app", icon: "plug", section: "Start here" },
  { file: "asking.html", title: "Editing by asking", icon: "chat", section: "Using the app" },
  { file: "tools.html", title: "All tools", icon: "tools", section: "Using the app" },
  { file: "troubleshooting.html", title: "Troubleshooting", icon: "help", section: "Help" },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Code blocks get a copy button. */
const withCopy = (html) => html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, code) => `<div class="code"><pre><code>${code}</code></pre><button class="copy" type="button" data-action="copy" aria-label="Copy">${icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>').replace("<svg", '<svg width="14" height="14"')}<span>Copy</span></button></div>`);

function layout(page, body, description) {
  const i = PAGES.indexOf(page);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  let nav = "";
  let section = "";
  for (const p of PAGES) {
    if (p.section !== section) nav += `<h4>${esc((section = p.section))}</h4>`;
    nav += `<a href="${p.file}"${p === page ? ' class="current" aria-current="page"' : ""}>${ICONS[p.icon]}${esc(p.title)}</a>`;
  }
  nav += `<h4>More</h4><a href="${REPO}">${ICONS.github}Source on GitHub</a><a href="${REPO}/issues">${ICONS.help}Report a problem</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} | VideditBridge</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="assets/icon-64.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="assets/style.css">
<script>try{const t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch{}</script>
</head>
<body>
<header class="top">
  <button class="icon-btn menu-btn" type="button" data-action="menu" aria-label="Menu">${ICONS.menu}</button>
  <a class="brand" href="index.html"><img src="assets/icon-64.png" alt="">VideditBridge</a>
  <span class="spacer"></span>
  <a class="link hide-sm" href="api-keys.html">API keys</a>
  <a class="link hide-sm" href="tools.html">Tools</a>
  <a class="link" href="${REPO}" aria-label="GitHub">${ICONS.github.replace("<svg", '<svg width="18" height="18" style="vertical-align:-4px"')}</a>
  <button class="icon-btn" type="button" data-action="theme" aria-label="Light or dark">${ICONS.sun}</button>
</header>
<div class="layout">
  <nav class="side" aria-label="Guide">${nav}</nav>
  <main>
    <article class="content">
${withCopy(body)}
      <nav class="pager">${prev ? `<a href="${prev.file}"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="next" href="${next.file}"><span>Next</span>${esc(next.title)}</a>` : ""}</nav>
      <footer class="foot"><span>VideditBridge user guide</span><a href="${REPO}/blob/main/site/pages/${page.file}">Edit this page on GitHub</a></footer>
    </article>
  </main>
</div>
<script src="assets/site.js"></script>
</body>
</html>
`;
}

/** The tools page, from the live tool list. */
async function toolsPage() {
  const data = JSON.parse(await readFile(path.join(root, "docs", "reference", "tools.json"), "utf8"));
  const ref = `${REPO}/blob/main/docs/reference/claude-tools.md`;
  let html = `<h1>All tools</h1>
<p class="lead">The ${data.count} tools the AI uses to edit your video. You do not call them yourself: you ask in your own words, and the AI picks the tools. Knowing what exists helps you ask for more.</p>
<p><input id="tool-search" class="search" type="search" placeholder="Search tools, for example: captions, sky, music, color" aria-label="Search tools"></p>
<p class="muted">Tools marked <span class="pill edits">edits</span> change the project and can be undone. The others look, listen or render without changing anything. Each name opens its full description and settings on GitHub.</p>
<p id="tool-empty" class="empty">No tool matches. Try another word.</p>
`;
  for (const g of data.groups) {
    html += `<section class="tool-group"><h2>${esc(g.group)} <small>${g.tools.length}</small></h2><div class="tools">`;
    for (const t of g.tools)
      html += `<div class="tool"><header><a href="${ref}#${t.name}">${esc(t.name)}</a><span class="pill${t.edits ? " edits" : ""}">${t.edits ? "edits" : "looks only"}</span></header><p>${esc(t.summary)}</p></div>`;
    html += `</div></section>\n`;
  }
  return html;
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "assets"), { recursive: true });
await cp(path.join(src, "assets"), path.join(out, "assets"), { recursive: true });
await cp(path.join(root, "ui", "Packaging", "icons", "AppIcon-64.png"), path.join(out, "assets", "icon-64.png"));
await cp(path.join(root, "ui", "Packaging", "icons", "AppIcon-256.png"), path.join(out, "assets", "icon-256.png"));
for (const page of PAGES) {
  let body;
  let description = "";
  if (page.file === "tools.html") {
    body = await toolsPage();
    description = "Every tool the AI can use in VideditBridge, by topic.";
  } else {
    const raw = await readFile(path.join(src, "pages", page.file), "utf8");
    // A page may start with <!-- description: ... --> for search engines and link previews.
    description = raw.match(/^<!--\s*description:\s*([\s\S]*?)-->/)?.[1]?.trim() ?? "";
    body = raw.replace(/^<!--[\s\S]*?-->\s*/, "");
  }
  await writeFile(path.join(out, page.file), layout(page, body, description), "utf8");
}
await writeFile(path.join(out, ".nojekyll"), "");
console.log(`Built ${PAGES.length} pages into ${path.relative(root, out)}`);
