"use strict";

const form = document.getElementById("proxyForm");
const addressInput = document.getElementById("addressInput");
const connectionLabel = document.getElementById("connectionLabel");
const emptyState = document.getElementById("emptyState");
const frameMount = document.getElementById("frameMount");
const homeButton = document.getElementById("homeButton");
const reloadButton = document.getElementById("reloadButton");
const detachButton = document.getElementById("detachButton");

const searchTemplate = "https://www.google.com/search?q=%s";
let currentUrl = "";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

homeButton.addEventListener("click", () => {
  currentUrl = "";
  addressInput.value = "";
  frameMount.replaceChildren();
  emptyState.hidden = false;
  connectionLabel.textContent = "Serverless proxy ready";
  addressInput.focus();
});

reloadButton.addEventListener("click", () => {
  const frame = frameMount.querySelector("iframe");
  if (frame?.contentWindow) frame.contentWindow.location.reload();
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
  emptyState.hidden = true;
  connectionLabel.textContent = new URL(url).hostname;

  let frame = frameMount.querySelector("iframe");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.title = "ProxyV browser";
    frame.className = "proxy-frame";
    frame.referrerPolicy = "no-referrer";
    frameMount.replaceChildren(frame);
  }

  frame.src = toProxyUrl(url);
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
    connectionLabel.textContent = status.mode || "Serverless proxy ready";
  } catch {
    connectionLabel.textContent = "Serverless proxy ready";
  }
}
