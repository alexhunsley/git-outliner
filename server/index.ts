import express from "express";
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ViewSchema } from "../src/model.ts";
import { inspect, readHistory } from "./git.ts";
import { ViewStore } from "./store.ts";
import { z } from "zod";
import { RewriteRulesSchema } from "../src/rewrite.ts";
import { rewriteMessages } from "./rewrite.ts";
const app = express();
const store = new ViewStore();
app.disable("x-powered-by");
// Reject cross-origin and DNS-rebinding requests before accessing local paths.
app.use((req, res, next) => {
  const host = req.headers.host || "";
  if (!/^127\.0\.0\.1:\d+$/.test(host))
    return void res
      .status(403)
      .json({ error: "Use the 127.0.0.1 address printed at startup." });
  const origin = req.headers.origin;
  if (
    (origin && origin !== `http://${host}`) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    return void res
      .status(403)
      .json({ error: "Cross-origin requests are not allowed." });
  next();
});
app.use(express.json({ limit: "2mb" }));
app.post("/api/repository", async (req, res) => {
  res.json(await inspect(req.body.path));
});
app.post("/api/history", async (req, res) => {
  res.json(await readHistory(req.body.path, ViewSchema.parse(req.body.view)));
});
app.post("/api/rewrite-preview", async (req, res) => {
  const input = z
    .object({ message: z.string().max(10000), rules: RewriteRulesSchema })
    .strict()
    .parse(req.body);
  const [message] = await rewriteMessages([input.message], input.rules);
  res.json({ message });
});
app.get("/api/views", async (_req, res) => {
  res.json(await store.list());
});
app.post("/api/views", async (req, res) => {
  res.json(await store.save(req.body));
});
app.delete("/api/views/:id", async (req, res) => {
  await store.delete(req.params.id);
  res.json({ ok: true });
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown API route." });
});
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(400).json({ error: error.message });
  },
);
const base = fileURLToPath(new URL("..", import.meta.url));
if (process.argv.includes("--production"))
  app.use(express.static(resolve(base, "dist")));
else {
  const vite = await createViteServer({
    root: base,
    server: { middlewareMode: true, hmr: false, ws: false, host: "127.0.0.1" },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 4317);
const server = createServer(app);
server.on("error", (error) => {
  console.error(`Cannot start Git Outliner: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Git Outliner: http://127.0.0.1:${port}`),
);
