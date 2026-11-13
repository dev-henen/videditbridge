# Using the editor from other AI apps (MCP)

The editor is also an [MCP](https://modelcontextprotocol.io) server, so you can add it to the Claude app (and to Gemini CLI or Claude Code) and edit by asking there. The Gemini app and ChatGPT need a public address and are turned off for now (see below). The server is [engine/mcp/server.ts](../../engine/mcp/server.ts) and its command is [engine/mcp/main.ts](../../engine/mcp/main.ts) (`ave-mcp`).

It offers the editor's tools (the [Claude tools reference](../reference/claude-tools.md)) and three tools for choosing the project: `list_projects`, `open_project` and `create_project`. Read-only tools are marked `readOnlyHint`, so apps that ask before a change ask only for edits. Rendered frames and contact sheets come back as pictures, so the model can see its work. The server's instructions are the desktop agent's system prompt.

## Where the preview shows

The preview shows in one place, picked by what the connected app can do:

- **Apps that show MCP Apps views (Claude, ChatGPT).** `render_preview`, `render_frame` and `render_contact_sheet` carry a view (`ui://ai-video-editor/preview.html`, [engine/mcp/view.ts](../../engine/mcp/view.ts)) that the app shows in the chat: the preview plays there, frames and contact sheets show there. The view loads the file with `fetch_media`, a tool only views can call, which reads only renders inside the projects' `.render` folders (40 MB at most). The editor app stays out of sight: when it is running, edits go through it without opening a tab (so one program writes the project), otherwise the server edits the project itself.
- **Apps that cannot show views (Gemini CLI, Claude Code).** The editor app is the preview window. It opens the project in a tab with a note ("Edited from Gemini CLI") instead of its chat, and the preview takes the chat's room; "Use the chat here" brings the chat back. When the app is not running, the server starts it (the app records how to start it in `app-launch.json` in its data folder, the first time it runs).

The server tells them apart by the client's `io.modelcontextprotocol/ui` capability. Over HTTP every request is a new connection, so the HTTP server treats its clients as apps that show views.

## From the app: Settings, Connections

The usual way. In the app, open Settings (the menu at the top left), then Connections:

- **Apps on this computer.** Connect adds the editor to the Claude app's or Gemini CLI's own MCP config, with the command for this install and its projects folder. The rest of the file stays as it was, and the previous one is kept as `<file>.bak`. Quit and reopen the Claude app, or start a new Gemini CLI session, to use it. Disconnect takes the entry out. An entry that points at another copy of the editor shows Update. For Claude Code, and for apps not listed, copy the command.
- **The Gemini app and ChatGPT: turned off for now.** Their connectors are called from Google's and OpenAI's servers, so they need the editor on a public https address (a tunnel to this computer), unlike the Claude app, which starts the editor on this computer. The code for it stays: the connector inside the app (`connect.http`) and a Cloudflare quick tunnel ([engine/mcp/tunnel.ts](../../engine/mcp/tunnel.ts), downloaded on first use, run with a config file of its own so a person's `~/.cloudflared/config.yml` does not take over). `REMOTE_APPS` in [engine/host/main.ts](../../engine/host/main.ts) turns it back on; while it is false, Settings shows no section for them and nothing starts the connector.

The host methods behind it are `connect.get`, `connect.set` and `connect.http` ([engine/host/connect.ts](../../engine/host/connect.ts)). The sections below are for doing the same by hand.

## Two ways to run

- **With the desktop app (the default).** The server drives the running app through its remote control socket (`<projects folder>/.host.json`). Edits land in the project the app has open, you watch them happen, and the app saves them and keeps the undo history. A project opened or created over MCP opens in a tab. Start the app first.
- **Standalone** (`--standalone`). The server opens projects from the projects folder itself and saves every change. Use this without the app, for example on a server. Don't open the same project in the app at the same time.

Both use the same projects folder as the app: `--projects-dir`, or `$AVE_PROJECTS_DIR`, else `./projects`. The Settings tab shows the app's folder.

## Claude desktop, Gemini CLI, Claude Code (stdio)

These apps start the server themselves. Add it to their MCP settings: `claude_desktop_config.json` for Claude desktop (Settings, Developer, Edit config), `~/.gemini/settings.json` for Gemini CLI. Both use the same shape:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/path/to/ai-video-editor/dist/mcp/main.js", "--projects-dir", "/path/to/projects"]
    }
  }
}
```

From a source checkout, run it through tsx instead: `"command": "npx", "args": ["tsx", "/path/to/ai-video-editor/engine/mcp/main.ts", "--projects-dir", "/path/to/projects"]`. For Claude Code: `claude mcp add video-editor -- node /path/to/dist/mcp/main.js --projects-dir /path/to/projects`.

## ChatGPT, and Claude or Gemini custom connectors (HTTP)

Apps that connect to a URL need the HTTP server:

```bash
ave-mcp --http --projects-dir /path/to/projects        # or: npm run mcp -- --http
# AI Video Editor MCP server (app) at http://127.0.0.1:3920/mcp/<token>
```

- **The token** is part of the URL, because ChatGPT's connectors cannot send a key header. Clients that can send headers may use `/mcp` with `Authorization: Bearer <token>` instead. Requests without the token get 404. The token is kept in the app's data folder (`mcp-token`), so the URL stays the same across restarts. Pass `--token` to choose one, and delete the file to make a new one.
- **ChatGPT reaches only public HTTPS addresses.** Put a tunnel in front of the local port, for example `cloudflared tunnel --url http://127.0.0.1:3920` or `ngrok http 3920`. Then, in ChatGPT, turn on developer mode (Settings, Apps and connectors, Advanced) and create a connector with the URL `https://<tunnel host>/mcp/<token>` and no authentication. Anyone with that URL can edit your projects, so share it with no one and stop the tunnel when you are done.
- **Other options:** `--port` (default 3920) and `--host` (default 127.0.0.1, so only this computer can reach it without a tunnel).

Over HTTP every request is independent (stateless Streamable HTTP), but the server keeps the open project between requests.
