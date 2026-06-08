const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const textTypes = [
  "text/html",
  "text/css",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript"
];

module.exports = async function handler(request, response) {
  try {
    await handleProxy(request, response);
  } catch (error) {
    console.error("Unhandled proxy error:", error);
    if (!response.headersSent) {
      sendText(response, 500, `Proxy function error: ${error.message}`);
    } else {
      response.end();
    }
  }
};

async function handleProxy(request, response) {
  const requestUrl = new URL(request.url || "/", getOrigin(request));
  const target = requestUrl.searchParams.get("url");

  if (!target) {
    sendText(response, 400, "Missing url parameter.");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    sendText(response, 400, "Invalid url parameter.");
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendText(response, 400, "Only http and https URLs can be proxied.");
    return;
  }

  try {
    const body = hasBody(request) ? await readRequestBody(request) : null;
    const upstream = await requestUpstream(request, targetUrl, body);
    await sendUpstreamResponse(request, response, upstream, targetUrl);
  } catch (error) {
    sendText(response, 502, `Proxy request failed: ${error.message}`);
  }
}

function requestUpstream(request, targetUrl, body) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.protocol === "https:" ? https : http;
    const headers = buildUpstreamHeaders(request, targetUrl, body);
    const upstreamRequest = client.request(
      targetUrl,
      {
        method: request.method || "GET",
        headers,
        timeout: 25000
      },
      (upstreamResponse) => {
        const chunks = [];

        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          resolve({
            statusCode: upstreamResponse.statusCode || 502,
            headers: upstreamResponse.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    upstreamRequest.on("timeout", () => upstreamRequest.destroy(new Error("Upstream request timed out.")));
    upstreamRequest.on("error", reject);

    if (body && body.length) upstreamRequest.write(body);
    upstreamRequest.end();
  });
}

async function sendUpstreamResponse(request, response, upstream, targetUrl) {
  const headers = upstream.headers || {};
  const contentType = getHeader(headers, "content-type") || "";
  const location = getHeader(headers, "location");
  const statusCode = upstream.statusCode;

  response.statusCode = statusCode;

  if (location && isRedirect(statusCode)) {
    setResponseHeader(response, "location", toProxyUrl(new URL(location, targetUrl).href));
  }

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower) || lower === "location" || lower === "set-cookie") continue;
    if (lower === "content-security-policy" || lower === "content-security-policy-report-only") continue;
    if (lower === "x-frame-options") continue;
    setResponseHeader(response, name, value);
  }

  const setCookie = splitHeaderArray(headers["set-cookie"]);
  if (setCookie.length) {
    setResponseHeader(response, "set-cookie", setCookie.map((cookie) => rewriteCookie(cookie)));
  }

  setResponseHeader(response, "access-control-allow-origin", "*");
  setResponseHeader(response, "x-proxyv-url", targetUrl.href);

  const decodedBody = decodeBody(upstream.body, getHeader(headers, "content-encoding"));

  if (!shouldRewrite(contentType, request.method)) {
    setResponseHeader(response, "cache-control", getHeader(headers, "cache-control") || "public, max-age=300");
    response.end(decodedBody);
    return;
  }

  let body = decodedBody.toString(getCharset(contentType));
  body = rewriteText(body, contentType, targetUrl);
  setResponseHeader(response, "content-type", normalizeTextContentType(contentType));
  response.end(body);
}

function buildUpstreamHeaders(request, targetUrl, body) {
  const headers = {};

  for (const [name, value] of Object.entries(request.headers || {})) {
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    if (lower.startsWith("sec-fetch")) continue;
    if (lower.startsWith("x-vercel")) continue;
    if (lower === "x-forwarded-for" || lower === "x-forwarded-host" || lower === "x-forwarded-proto") continue;

    if (lower === "origin") {
      headers.origin = targetUrl.origin;
      continue;
    }

    if (lower === "referer") {
      headers.referer = targetUrl.href;
      continue;
    }

    if (Array.isArray(value)) headers[name] = value.join(", ");
    else if (value !== undefined) headers[name] = String(value);
  }

  headers["accept-encoding"] = "identity";
  headers.host = targetUrl.host;
  if (body) headers["content-length"] = String(body.length);

  if (!Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) {
    headers["user-agent"] =
      "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0";
  }

  return headers;
}

function decodeBody(body, encoding = "") {
  const lower = String(encoding).toLowerCase();

  try {
    if (lower.includes("gzip")) return zlib.gunzipSync(body);
    if (lower.includes("br")) return zlib.brotliDecompressSync(body);
    if (lower.includes("deflate")) return zlib.inflateSync(body);
  } catch {
    return body;
  }

  return body;
}

function rewriteText(body, contentType, baseUrl) {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/html")) return rewriteHtml(body, baseUrl);
  if (lower.includes("text/css")) return rewriteCss(body, baseUrl);
  return rewriteJavaScript(body, baseUrl);
}

function rewriteHtml(html, baseUrl) {
  let output = html
    .replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/(<head\b[^>]*>)/i, `$1${clientRuntime(baseUrl.href)}`)
    .replace(/\s(?:integrity|nonce)=["'][^"']*["']/gi, "")
    .replace(
      /\b(href|src|action|poster|data|xlink:href|formaction|manifest)=("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (match, attr, raw, doubleQuoted, singleQuoted, unquoted) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
        const rewritten = rewriteUrl(value, baseUrl);
        return `${attr}="${escapeAttribute(rewritten)}"`;
      }
    )
    .replace(/\bsrcset=("([^"]*)"|'([^']*)')/gi, (match, raw, doubleQuoted, singleQuoted) => {
      const value = doubleQuoted ?? singleQuoted ?? "";
      return `srcset="${escapeAttribute(rewriteSrcset(value, baseUrl))}"`;
    })
    .replace(/\bstyle=("([^"]*)"|'([^']*)')/gi, (match, raw, doubleQuoted, singleQuoted) => {
      const value = doubleQuoted ?? singleQuoted ?? "";
      return `style="${escapeAttribute(rewriteCss(value, baseUrl))}"`;
    })
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
      return `${open}${rewriteCss(css, baseUrl)}${close}`;
    })
    .replace(
      /(<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'])([^"']+)(["'][^>]*>)/gi,
      (match, open, content, close) => {
        return `${open}${escapeAttribute(rewriteRefresh(content, baseUrl))}${close}`;
      }
    );

  if (!/<head\b/i.test(output)) output = `${clientRuntime(baseUrl.href)}${output}`;
  return output;
}

function rewriteCss(css, baseUrl) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, value) => {
      return `url("${rewriteUrl(value.trim(), baseUrl)}")`;
    })
    .replace(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?/gi, (match, value) => {
      return `@import url("${rewriteUrl(value, baseUrl)}")`;
    });
}

function rewriteJavaScript(source, baseUrl) {
  return source
    .replace(
      /\b(import\s*(?:\([^)]*|[^"']*from\s*)|export\s+[^"']*from\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => `${prefix}${quote}${rewriteUrl(specifier, baseUrl)}${quote}`
    )
    .replace(
      /\b(new\s+(?:Worker|SharedWorker)\s*\(\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => `${prefix}${quote}${rewriteUrl(specifier, baseUrl)}${quote}`
    );
}

function clientRuntime(baseUrl) {
  return `
<script>
(() => {
  const proxy = (value) => {
    try {
      const url = new URL(value, ${JSON.stringify(baseUrl)});
      if (url.protocol !== "http:" && url.protocol !== "https:") return value;
      return "/api/proxy?url=" + encodeURIComponent(url.href);
    } catch {
      return value;
    }
  };
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) return originalFetch(proxy(input), init);
    if (input instanceof Request) return originalFetch(new Request(proxy(input.url), input), init);
    return originalFetch(input, init);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, proxy(url), ...rest);
  };
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    form.action = proxy(form.action || location.href);
  }, true);
})();
</script>`;
}

function rewriteUrl(value, baseUrl) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return value;
  if (/^(?:data|blob|mailto|tel|javascript):/i.test(trimmed)) return value;

  try {
    const absolute = new URL(trimmed, baseUrl);
    if (!["http:", "https:"].includes(absolute.protocol)) return value;
    return toProxyUrl(absolute.href);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) return candidate;
      parts[0] = rewriteUrl(parts[0], baseUrl);
      return parts.join(" ");
    })
    .join(", ");
}

function rewriteRefresh(content, baseUrl) {
  return content.replace(/url=([^;]+)/i, (match, value) => `url=${rewriteUrl(value.trim(), baseUrl)}`);
}

function toProxyUrl(url) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

function shouldRewrite(contentType, method = "GET") {
  if (method === "HEAD") return false;
  return textTypes.some((type) => contentType.toLowerCase().includes(type));
}

function normalizeTextContentType(contentType) {
  if (contentType) return contentType.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function getCharset(contentType) {
  const match = /charset=([^;]+)/i.exec(contentType);
  return match ? match[1].trim().toLowerCase() : "utf8";
}

function hasBody(request) {
  return !["GET", "HEAD"].includes(request.method || "GET");
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function getOrigin(request) {
  const proto = getHeader(request.headers || {}, "x-forwarded-proto") || "http";
  const host =
    getHeader(request.headers || {}, "x-forwarded-host") ||
    getHeader(request.headers || {}, "host") ||
    "localhost";
  return `${proto}://${host}`;
}

function getHeader(headers, name) {
  const value = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function splitHeaderArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*secure/gi, "")
    .replace(/;\s*samesite=(lax|strict|none)/gi, "; SameSite=Lax");
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sendText(response, status, message) {
  response.statusCode = status;
  setResponseHeader(response, "content-type", "text/plain; charset=utf-8");
  response.end(message);
}

function setResponseHeader(response, name, value) {
  try {
    if (value !== undefined && value !== null) response.setHeader(name, value);
  } catch {
    // Drop invalid upstream headers.
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
