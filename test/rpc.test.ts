import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { serveLocal } from "../src/host/rpc.js";

describe("local remote-control socket", () => {
  it("survives a client that resets the connection mid-session", async () => {
    const { server, port } = await serveLocal({ ping: async () => "pong" }, "secret");
    try {
      // A client that authenticates, then dies abruptly (a crashing script) with a TCP reset.
      const crash = connect(port, "127.0.0.1");
      await new Promise((r) => crash.once("connect", r));
      crash.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "auth", params: { token: "secret" } })}\n`);
      await new Promise((r) => crash.once("data", r));
      crash.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 100));

      // The server still answers the next client.
      const next = connect(port, "127.0.0.1");
      await new Promise((r) => next.once("connect", r));
      const replies: string[] = [];
      next.setEncoding("utf8");
      next.on("data", (d: string) => replies.push(...d.trim().split("\n")));
      next.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "auth", params: { token: "secret" } })}\n`);
      next.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      for (let n = 0; n < 50 && replies.length < 2; n++) await new Promise((r) => setTimeout(r, 20));
      expect(replies.map((r) => JSON.parse(r) as { id: number; result: unknown }).find((r) => r.id === 2)?.result).toBe("pong");
      next.destroy();
    } finally {
      server.close();
    }
  });
});
