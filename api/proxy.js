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

export default async function handler(request, response) {
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
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, targetUrl),
      body: hasBody(request) ? request : undefined,
      redirect: "manual",
      duplex: hasBody(request) ? "half" : undefined
    });

    await sendUpstreamResponse(request, response, upstream, targetUrl);
  } catch (error) {
    sendText(response, 502, `Proxy request failed: ${error.message}`);
  }
}

async function sendUpstreamResponse(request, response, upstream, targetUrl) {
  const headers = new Headers(upstream.headers);
  const contentType = headers.get("content-type") || "";
  const location = headers.get("location");

  response.statusCode = upstream.status;

  if (location && isRedirect(upstream.status)) {
    response.setHeader("location", toProxyUrl(new URL(location, targetUrl).href, request));
  }

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower) || lower === "location" || lower === "set-cookie") continue;
    if (lower === "content-security-policy" || lower === "content-security-policy-report-only") continue;
    if (lower === "x-frame-options") continue;
    response.setHeader(name, value);
  }

  const setCookie = headers.getSetCookie?.() || splitSetCookie(headers.get("set-cookie"));
  if (setCookie.length) {
    response.setHeader("set-cookie", setCookie.map((cookie) => rewriteCookie(cookie)));
  }

  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("x-proxyv-url", targetUrl.href);

  if (!shouldRewrite(contentType, request.method)) {
    if (upstream.body) {
      response.statusCode = upstream.status;
      response.setHeader("cache-control", headers.get("cache-control") || "public, max-age=300");
      await pipeWebStream(upstream.body, response);
    } else {
      response.end();
    }
    return;
  }

  let body = await upstream.text();
  body = rewriteText(body, contentType, targetUrl, request);
  response.removeHeader("content-length");
  response.setHeader("content-type", normalizeTextContentType(contentType));
  response.end(body);
}

function buildUpstreamHeaders(request, targetUrl) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    if (lower.startsWith("sec-fetch")) continue;
    if (lower === "origin") {
      headers.set("origin", targetUrl.origin);
      continue;
    }
    if (lower === "referer") {
      headers.set("referer", targetUrl.href);
      continue;
    }
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value) headers.set(name, value);
  }

  headers.set("host", targetUrl.host);
  headers.set("accept-encoding", "identity");
  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0"
    );
  }

  return headers;
}

function rewriteText(body, contentType, baseUrl, request) {
  if (contentType.includes("text/html")) return rewriteHtml(body, baseUrl, request);
  if (contentType.includes("text/css")) return rewriteCss(body, baseUrl, request);
  return rewriteJavaScript(body, baseUrl, request);
}

function rewriteHtml(html, baseUrl, request) {
  let output = html
    .replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/(<head\b[^>]*>)/i, `$1${clientRuntime(baseUrl.href)}`)
    .replace(/\s(?:integrity|nonce)=["'][^"']*["']/gi, "")
    .replace(
      /\b(href|src|action|poster|data|xlink:href|formaction|manifest)=("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (match, attr, raw, doubleQuoted, singleQuoted, unquoted) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
        const rewritten = rewriteUrl(value, baseUrl, request);
        return `${attr}="${escapeAttribute(rewritten)}"`;
      }
    )
    .replace(/\bsrcset=("([^"]*)"|'([^']*)')/gi, (match, raw, doubleQuoted, singleQuoted) => {
      const value = doubleQuoted ?? singleQuoted ?? "";
      return `srcset="${escapeAttribute(rewriteSrcset(value, baseUrl, request))}"`;
    })
    .replace(/\bstyle=("([^"]*)"|'([^']*)')/gi, (match, raw, doubleQuoted, singleQuoted) => {
      const value = doubleQuoted ?? singleQuoted ?? "";
      return `style="${escapeAttribute(rewriteCss(value, baseUrl, request))}"`;
    })
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
      return `${open}${rewriteCss(css, baseUrl, request)}${close}`;
    })
    .replace(
      /(<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'])([^"']+)(["'][^>]*>)/gi,
      (match, open, content, close) => {
        return `${open}${escapeAttribute(rewriteRefresh(content, baseUrl, request))}${close}`;
      }
    );

  if (!/<head\b/i.test(output)) {
    output = `${clientRuntime(baseUrl.href)}${output}`;
  }

  return output;
}

function rewriteCss(css, baseUrl, request) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, value) => {
      return `url("${rewriteUrl(value.trim(), baseUrl, request)}")`;
    })
    .replace(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?/gi, (match, value) => {
      return `@import url("${rewriteUrl(value, baseUrl, request)}")`;
    });
}

function rewriteJavaScript(source, baseUrl, request) {
  return source
    .replace(
      /\b(import\s*(?:\([^)]*|[^"']*from\s*)|export\s+[^"']*from\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => {
        return `${prefix}${quote}${rewriteUrl(specifier, baseUrl, request)}${quote}`;
      }
    )
    .replace(
      /\b(new\s+(?:Worker|SharedWorker)\s*\(\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => {
        return `${prefix}${quote}${rewriteUrl(specifier, baseUrl, request)}${quote}`;
      }
    );
}

function clientRuntime(baseUrl) {
  const script = `
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
  return script;
}

function rewriteUrl(value, baseUrl, request) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return value;
  if (/^(?:data|blob|mailto|tel|javascript):/i.test(trimmed)) return value;

  try {
    const absolute = new URL(trimmed, baseUrl);
    if (!["http:", "https:"].includes(absolute.protocol)) return value;
    return toProxyUrl(absolute.href, request);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl, request) {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) return candidate;
      parts[0] = rewriteUrl(parts[0], baseUrl, request);
      return parts.join(" ");
    })
    .join(", ");
}

function rewriteRefresh(content, baseUrl, request) {
  return content.replace(/url=([^;]+)/i, (match, value) => {
    return `url=${rewriteUrl(value.trim(), baseUrl, request)}`;
  });
}

function toProxyUrl(url, request) {
  const origin = request ? "" : "";
  return `${origin}/api/proxy?url=${encodeURIComponent(url)}`;
}

function shouldRewrite(contentType, method = "GET") {
  if (method === "HEAD") return false;
  return textTypes.some((type) => contentType.toLowerCase().includes(type));
}

function normalizeTextContentType(contentType) {
  if (contentType) return contentType.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function hasBody(request) {
  return !["GET", "HEAD"].includes(request.method || "GET");
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function getOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
  return `${proto}://${host}`;
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*secure/gi, "")
    .replace(/;\s*samesite=(lax|strict|none)/gi, "; SameSite=Lax");
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sendText(response, status, message) {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(message);
}

async function pipeWebStream(stream, response) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
  } finally {
    response.end();
  }
}
