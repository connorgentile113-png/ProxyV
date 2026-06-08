"use strict";

const form = document.getElementById("proxyForm");
const addressInput = document.getElementById("addressInput");
const connectionLabel = document.getElementById("connectionLabel");
const emptyState = document.getElementById("emptyState");
const homeButton = document.getElementById("homeButton");
const reloadButton = document.getElementById("reloadButton");
const detachButton = document.getElementById("detachButton");
const ngrokUrl = document.getElementById("ngrokUrl");

const searchTemplate = "https://www.google.com/search?q=%s";
let currentUrl = "";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

homeButton.addEventListener("click", () => {
  currentUrl = "";
  addressInput.value = "";
  emptyState.hidden = false;
  addressInput.focus();
  void refreshStatus();
});

reloadButton.addEventListener("click", () => {
  window.location.reload();
});

detachButton.addEventListener("click", () => {
  if (currentUrl) window.open(toProxyUrl(currentUrl), "_blank", "noopener,noreferrer");
});

void refreshStatus();

function navigate(input) {
  const url = normalizeAddress(input);
  if (!url) return;

  currentUrl = url;
  addressInput.value = url;
  connectionLabel.textContent = new URL(url).hostname;
  window.location.href = toProxyUrl(url);
}

function normalizeAddress(input) {
  const value = input.trim();
  if (!value) return "";

  try {
    return new URL(value).toString();
  } catch {
    try {
      const withScheme = new URL(`https://${value}`);
      if (withScheme.hostname.includes(".")) return withScheme.toString();
    } catch {
      return searchTemplate.replace("%s", encodeURIComponent(value));
    }
  }

  return searchTemplate.replace("%s", encodeURIComponent(value));
}

function toProxyUrl(url) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    connectionLabel.textContent = status.mode || "Proxy ready";
    if (status.ngrokUrl) {
      ngrokUrl.textContent = status.ngrokUrl;
      ngrokUrl.href = status.ngrokUrl;
    } else {
      ngrokUrl.textContent = "Starting...";
      ngrokUrl.removeAttribute("href");
    }
  } catch {
    connectionLabel.textContent = "Status unavailable";
    ngrokUrl.textContent = "Unavailable";
    ngrokUrl.removeAttribute("href");
  }
}

setInterval(refreshStatus, 5000);
