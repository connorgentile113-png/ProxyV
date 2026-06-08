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
  const target = getTargetUrl(requestUrl);

  if (!target) {
    sendText(response, 400, "Missing target parameter.");
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
  const proxyvBaseUrl = ${JSON.stringify(baseUrl)};
  const debugEntries = [];
  const format = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const addDebug = (level, message) => {
    debugEntries.push({ time: new Date().toISOString(), level, message });
    if (debugEntries.length > 300) debugEntries.shift();
    const log = document.getElementById("proxyv-debug-log");
    if (log) renderDebug(log);
  };
  const renderDebug = (log) => {
    log.textContent = debugEntries.map((entry) => "[" + entry.time + "] " + entry.level.toUpperCase() + " " + entry.message).join("\\n");
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      addDebug(level, args.map(format).join(" "));
      original(...args);
    };
  }
  window.addEventListener("error", (event) => addDebug("error", event.message + " at " + event.filename + ":" + event.lineno + ":" + event.colno));
  window.addEventListener("unhandledrejection", (event) => addDebug("error", "Unhandled rejection: " + format(event.reason)));
  const encodeTarget = (value) => btoa(unescape(encodeURIComponent(value))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  const normalize = (value) => {
    try {
      const url = new URL(value, proxyvBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch {
      return "";
    }
  };
  const proxy = (value) => {
    const url = normalize(value);
    return url ? "/api/proxy?u=" + encodeURIComponent(encodeTarget(url)) : value;
  };
  const reportLoaded = () => {
    try { window.parent.postMessage({ source: "proxyv", type: "loaded", url: proxyvBaseUrl }, window.location.origin); } catch {}
  };
  const requestNavigation = (value) => {
    const url = normalize(value);
    if (!url) return false;
    try { window.parent.postMessage({ source: "proxyv", type: "navigate", url }, window.location.origin); } catch {}
    window.location.href = proxy(url);
    return true;
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
  const originalWorker = window.Worker;
  if (originalWorker) {
    window.Worker = function(url, options) {
      return new originalWorker(proxy(url), options);
    };
  }
  const originalSharedWorker = window.SharedWorker;
  if (originalSharedWorker) {
    window.SharedWorker = function(url, options) {
      return new originalSharedWorker(proxy(url), options);
    };
  }
  const rewriteElementUrl = (element, attr) => {
    const value = element.getAttribute(attr);
    if (value) element.setAttribute(attr, proxy(value));
  };
  const rewriteTree = (root) => {
    if (!root.querySelectorAll) return;
    root.querySelectorAll("[src],[href],[action],[poster],[data],[formaction]").forEach((element) => {
      for (const attr of ["src", "href", "action", "poster", "data", "formaction"]) rewriteElementUrl(element, attr);
    });
    root.querySelectorAll("[srcset]").forEach((element) => {
      element.srcset = element.srcset.split(",").map((candidate) => {
        const parts = candidate.trim().split(/\\s+/);
        if (parts[0]) parts[0] = proxy(parts[0]);
        return parts.join(" ");
      }).join(", ");
    });
  };
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href],area[href]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = (link.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return;
    event.preventDefault();
    requestNavigation(link.getAttribute("href") || link.href);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    form.action = proxy(form.getAttribute("action") || location.href);
  }, true);
  const originalPushState = history.pushState;
  history.pushState = function(state, title, url) {
    if (url && requestNavigation(url)) return;
    return originalPushState.apply(this, arguments);
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function(state, title, url) {
    if (url && requestNavigation(url)) return;
    return originalReplaceState.apply(this, arguments);
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          rewriteTree(node);
          if (node.matches && node.matches("[src],[href],[action],[poster],[data],[formaction]")) {
            for (const attr of ["src", "href", "action", "poster", "data", "formaction"]) rewriteElementUrl(node, attr);
          }
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Debug";
  button.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483647;background:#151a21;color:#edf2f7;border:1px solid #38bdf8;border-radius:7px;padding:8px 10px;font:13px system-ui;cursor:pointer";
  button.addEventListener("click", async () => {
    let panel = document.getElementById("proxyv-debug-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "proxyv-debug-panel";
      panel.style.cssText = "position:fixed;right:10px;bottom:54px;width:min(720px,calc(100vw - 20px));height:min(460px,calc(100vh - 74px));z-index:2147483647;background:#070b10;color:#d9e6f2;border:1px solid #2c3440;border-radius:7px;box-shadow:0 12px 36px rgba(0,0,0,.45);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;grid-template-rows:auto 1fr";
      panel.innerHTML = '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px;border-bottom:1px solid #2c3440"><strong>Browser console</strong><span><button id="proxyv-debug-copy" type="button">Copy</button> <button id="proxyv-debug-close" type="button">Close</button></span></div><pre id="proxyv-debug-log" style="margin:0;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word"></pre>';
      document.documentElement.appendChild(panel);
      panel.querySelector("#proxyv-debug-close").addEventListener("click", () => panel.remove());
      panel.querySelector("#proxyv-debug-copy").addEventListener("click", async () => {
        const log = document.getElementById("proxyv-debug-log");
        await navigator.clipboard.writeText(log ? log.textContent : "");
      });
    }
    renderDebug(panel.querySelector("#proxyv-debug-log"));
  });
  document.addEventListener("DOMContentLoaded", () => {
    rewriteTree(document);
    document.documentElement.appendChild(button);
    reportLoaded();
  }, { once: true });
  addDebug("info", "ProxyV runtime loaded at " + location.href);
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
  return `/api/proxy?u=${encodeURIComponent(toBase64Url(url))}`;
}

function getTargetUrl(requestUrl) {
  const encoded = requestUrl.searchParams.get("u");
  if (encoded) return fromBase64Url(encoded);
  return requestUrl.searchParams.get("url");
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
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
