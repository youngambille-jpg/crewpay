/**
 * Production server for the console: serves the built client statically and
 * forwards everything else (pages, server functions) to the TanStack handler.
 *
 * There is no framework Node adapter in this stack (the template shipped a
 * Cloudflare one), so this file is it — stdlib only, ~70 lines. Bodies are
 * buffered because this app's server traffic is small JSON; there are no
 * uploads to stream.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(root, "dist", "client");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const { default: handler } = await import(path.join(root, "dist", "server", "server.js"));
if (!handler || typeof handler.fetch !== "function") {
  console.error(" dist/server/server.js does not export a fetch handler; run `npm run build` first.");
  process.exit(1);
}

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Static first: exact files under dist/client only (traversal-proofed).
    if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.includes("\0")) {
      const file = path.normalize(path.join(clientDir, `.${url.pathname}`));
      if (file.startsWith(clientDir + path.sep) || file === clientDir) {
        try {
          const st = await stat(file);
          if (st.isFile()) {
            const immutable = url.pathname.startsWith("/assets/");
            res.writeHead(200, {
              "content-type": contentType(file),
              "content-length": st.size,
              "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
            });
            if (req.method === "GET") res.end(await readFile(file));
            else res.end();
            return;
          }
        } catch {
          // Not a file: fall through to the app handler.
        }
      }
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handler.fetch(request);

    const headers = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-length") headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`console error: ${err instanceof Error ? err.message : err}`);
  }
});

await new Promise((resolve) => server.listen(PORT, HOST, resolve));
console.log(`crewpay console on http://${HOST}:${PORT} (api: ${process.env.API_ORIGIN ?? "http://127.0.0.1:4000"})`);
