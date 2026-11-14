// VideditBridge user guide: theme, phone menu, copy buttons, screenshot zoom and tool search.
(() => {
  const root = document.documentElement;
  let stored = null;
  try { stored = localStorage.getItem("theme"); } catch { /* private window */ }
  if (stored) root.dataset.theme = stored;

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    const action = t.dataset.action;
    if (action === "theme") {
      const dark = (root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")) === "dark";
      root.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("theme", root.dataset.theme); } catch { /* fine */ }
    } else if (action === "menu") {
      document.body.classList.toggle("nav-open");
    } else if (action === "copy") {
      const text = t.closest(".code").querySelector("code").innerText;
      try {
        await navigator.clipboard.writeText(text);
        const label = t.querySelector("span");
        t.classList.add("done");
        label.textContent = "Copied";
        setTimeout(() => { t.classList.remove("done"); label.textContent = "Copy"; }, 1500);
      } catch { /* the browser said no */ }
    }
  });

  // Screenshots open larger.
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = "<img alt=''>";
  document.body.appendChild(box);
  document.addEventListener("click", (e) => {
    const img = e.target.closest("img.shot");
    if (img) {
      box.querySelector("img").src = img.src;
      box.querySelector("img").alt = img.alt;
      box.classList.add("open");
    } else if (e.target.closest(".lightbox")) box.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") box.classList.remove("open"); });

  // Download page: the newest release's installers (prereleases too), straight from GitHub. Without an
  // answer the buttons keep pointing at the releases page.
  const releaseLine = document.getElementById("release-line");
  if (releaseLine) {
    const repo = "dev-henen/videditbridge";
    const match = { windows: /windows.*\.exe$/i, macos: /macos.*\.dmg$/i, linux: /\.AppImage$/i };
    const mine = /Win/.test(navigator.platform) ? "windows" : /Mac/.test(navigator.platform) ? "macos" : /Linux/.test(navigator.platform) ? "linux" : null;
    if (mine) document.querySelector(`.card[data-os="${mine}"]`)?.classList.add("mine");
    fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((releases) => {
        const release = releases.find((r) => !r.draft && r.assets.length);
        if (!release) return;
        const date = new Date(release.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        releaseLine.innerHTML = `Version <strong>${release.tag_name.replace(/^v/, "")}</strong>${release.prerelease ? " (test build)" : ""}, released ${date}. <a href="${release.html_url}">What is new</a>.`;
        for (const [os, re] of Object.entries(match)) {
          const asset = release.assets.find((a) => re.test(a.name));
          if (!asset) continue;
          document.querySelector(`[data-asset="${os}"]`).href = asset.browser_download_url;
          document.querySelector(`[data-size="${os}"]`).textContent = `${asset.name}, ${(asset.size / 1e9).toFixed(2)} GB`;
        }
      })
      .catch(() => { /* the links to the releases page stay */ });
  }

  // Close the phone menu after picking a page.
  document.querySelectorAll(".side a").forEach((a) => a.addEventListener("click", () => document.body.classList.remove("nav-open")));

  // Tools page: filter by name or what it does.
  const search = document.getElementById("tool-search");
  if (search) {
    const run = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      document.querySelectorAll(".tool-group").forEach((g) => {
        let inGroup = 0;
        g.querySelectorAll(".tool").forEach((t) => {
          const hit = !q || t.textContent.toLowerCase().includes(q);
          t.style.display = hit ? "" : "none";
          if (hit) inGroup++;
        });
        g.style.display = inGroup ? "" : "none";
        shown += inGroup;
      });
      document.getElementById("tool-empty").style.display = shown ? "none" : "block";
    };
    search.addEventListener("input", run);
  }
})();
