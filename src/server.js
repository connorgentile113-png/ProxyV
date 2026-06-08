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
let ngrokState = "not started";
let ngrokError = "";
let ngrokAttempts = 0;

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
      mode: ngrokUrl ? "ngrok tunnel online" : `ngrok ${ngrokState}`,
      ngrokUrl,
      ngrokError,
      ngrokAttempts,
      publicUrl: getRequestOrigin(request)
    });
    return;
  }

  if (await proxyImplicitRequest(request, response)) return;

  serveStatic(request, response);
});

server.listen(port, host, async () => {
  console.log(`ProxyV is listening on ${host}:${port}`);
  startNgrok();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startNgrok() {
  if (!process.env.NGROK_AUTHTOKEN) {
    ngrokState = "disabled";
    ngrokError = "NGROK_AUTHTOKEN is not set.";
    console.warn("NGROK_AUTHTOKEN is not set; no ngrok URL will be generated.");
    return;
  }

  ngrokAttempts += 1;
  ngrokState = "starting";
  ngrokError = "";
  const addr = `localhost:${port}`;
  console.log(`Starting ngrok tunnel to ${addr} (attempt ${ngrokAttempts}).`);

  try {
    const options = {
      addr,
      authtoken_from_env: true,
      proto: "http",
      schemes: ["HTTPS"]
    };

    if (process.env.NGROK_DOMAIN) options.domain = process.env.NGROK_DOMAIN;

    ngrokListener = await withTimeout(
      ngrok.forward(options),
      Number.parseInt(process.env.NGROK_START_TIMEOUT_MS || "30000", 10),
      "ngrok startup timed out"
    );
    ngrokUrl = ngrokListener.url();
    ngrokState = "online";
    console.log(`ngrok URL: ${ngrokUrl}`);
  } catch (error) {
    ngrokState = "failed";
    ngrokError = error && error.message ? error.message : String(error);
    console.error(`ngrok failed to start: ${ngrokError}`);

    const retryDelay = Number.parseInt(process.env.NGROK_RETRY_DELAY_MS || "15000", 10);
    setTimeout(startNgrok, retryDelay).unref();
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
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

async function proxyImplicitRequest(request, response) {
  const target = inferTargetFromProxiedReferer(request);
  if (!target) return false;

  request.url = `/api/proxy?u=${encodeURIComponent(toBase64Url(target))}`;
  await proxyHandler(request, response);
  return true;
}

function inferTargetFromProxiedReferer(request) {
  if (!request.url || request.url.startsWith("/api/")) return "";

  const requested = new URL(request.url, getRequestOrigin(request) || "http://localhost");
  if (requested.pathname === "/" || existingPublicFile(requested.pathname)) return "";

  const referer = request.headers.referer || request.headers.referrer;
  if (!referer) return "";

  let refererUrl;
  try {
    refererUrl = new URL(referer, getRequestOrigin(request) || "http://localhost");
  } catch {
    return "";
  }

  if (refererUrl.pathname !== "/api/proxy") return "";

  const baseTarget = getProxyTarget(refererUrl);
  if (!baseTarget) return "";

  try {
    return new URL(request.url, baseTarget).href;
  } catch {
    return "";
  }
}

function existingPublicFile(pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  return filePath.startsWith(publicDir) && existsSync(filePath) && !statSync(filePath).isDirectory();
}

function getProxyTarget(proxyUrl) {
  const encoded = proxyUrl.searchParams.get("u");
  if (encoded) {
    try {
      return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      return "";
    }
  }

  return proxyUrl.searchParams.get("url") || "";
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
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
