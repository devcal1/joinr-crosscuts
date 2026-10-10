// Shared helpers for the schedule/workers pages (plain global functions, no
// build step — load this before the page's own script).

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options && options.headers) },
  });
  if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
    const body = await res.json().catch(() => ({}));
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = (body.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
    return new Promise(() => {}); // never resolves: the page is navigating away, so callers must not toast
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);" +
    "color:var(--body);border:1px solid var(--hairline);border-radius:var(--r-card);padding:8px 14px;" +
    "font-family:var(--font);font-size:13px;z-index:50";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(`Error: ${e.message}`);
    }
  };
}

// Kept in sync by hand with hueColors() in server.js — the server copy is
// authoritative (it colors the chips the board and JPG export show); this one
// only drives the workers-page hue-slider preview.
function hueColors(hue) {
  return { bg: `oklch(30% 0.06 ${hue})`, fg: `oklch(86% 0.10 ${hue})` };
}
