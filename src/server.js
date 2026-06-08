const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize } = require("node:path");
const ngrok = require("@ngrok/ngrok");

const proxyHandler = require("../api/proxy.js");

const root = join(__dirname, "..");
const publicDir = join(root, "public");
const port = Number.parseInt(process.env.PORT || "8080", 10);
const host = process.env.HOST || "0.0.0.0";
let ngrokListener = null;
let ngrokUrl = "";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  if (request.url && request.url.startsWith("/api/proxy")) {
    await proxyHandler(request, response);
    return;
  }

  if (request.url === "/api/status") {
    sendJson(response, {
      mode: ngrokUrl ? "ngrok tunnel online" : "Waiting for ngrok tunnel",
      ngrokUrl,
      publicUrl: getRequestOrigin(request)
    });
    return;
  }

  serveStatic(request, response);
});

server.listen(port, host, async () => {
  console.log(`ProxyV is listening on ${host}:${port}`);
  await startNgrok();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startNgrok() {
  if (!process.env.NGROK_AUTHTOKEN) {
    console.warn("NGROK_AUTHTOKEN is not set; no ngrok URL will be generated.");
    return;
  }

  try {
    const options = {
      addr: `http://127.0.0.1:${port}`,
      authtoken: process.env.NGROK_AUTHTOKEN,
      schemes: ["HTTPS"]
    };

    if (process.env.NGROK_DOMAIN) options.domain = process.env.NGROK_DOMAIN;

    ngrokListener = await ngrok.forward(options);
    ngrokUrl = ngrokListener.url();
    console.log(`ngrok URL: ${ngrokUrl}`);
  } catch (error) {
    console.error(`ngrok failed to start: ${error.message}`);
  }
}

function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(publicDir, "index.html");
  }

  response.setHeader("Content-Type", mimeTypes[extname(filePath)] || "application/octet-stream");
  createReadStream(filePath).pipe(response);
}

function sendJson(response, data) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function getRequestOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "http";
  const hostHeader = request.headers["x-forwarded-host"] || request.headers.host;
  return hostHeader ? `${proto}://${hostHeader}` : "";
}

async function shutdown() {
  try {
    if (ngrokListener) await ngrokListener.close();
  } catch (error) {
    console.error(`ngrok shutdown error: ${error.message}`);
  }

  server.close(() => process.exit(0));
}
