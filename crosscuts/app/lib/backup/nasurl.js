// The NAS address rule (docs/plans/backup-contracts.md section 3.2). Pure, with no requires:
// the backup helper (tools/backup-secrets.mjs) loads this file too.
//
//   rsync://<account>@<IPv4>[:<port>]/<module>[/<subfolder>][/]
//
// Ported from Joinr Finance's checkNasUrl and tightened to an IP address (MagicDNS names don't
// resolve inside containers). A refusal never quotes the input: it says only whether there was
// any text at all.

// The account, module and subfolder allowlist (after percent-decoding), at most 64 characters.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEGMENT_MAX = 64;
// One IPv4 part: 0-255 with no leading zero.
const OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;
// The whole address, split: account, host, optional port, path. No whitespace, `?` or `#` anywhere.
const SHAPE_RE = /^rsync:\/\/([^@/?#\s]+)@([^:/?#@\s[\]]*)(?::(\d{1,5}))?(\/[^?#\s]*)$/i;

function refuse(configured) {
  return { ok: false, configured };
}

// decodeURIComponent that answers null instead of throwing.
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function segmentOk(text) {
  return typeof text === "string" && text.length <= SEGMENT_MAX && SEGMENT_RE.test(text);
}

// The four parts of a dotted IPv4 address as numbers, or null.
function ipv4Parts(host) {
  if (typeof host !== "string") return null;
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!OCTET_RE.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// {ok: true, url: 'rsync://acct@1.2.3.4[:p]/module[/sub]/', hasSubfolder} | {ok: false, configured}.
// NEVER throws, for any input.
function checkNasUrl(raw) {
  try {
    if (typeof raw !== "string") return refuse(false);
    const text = raw.trim();
    if (text === "") return refuse(false);
    const shape = SHAPE_RE.exec(text);
    if (shape === null) return refuse(true);
    const rawAccount = shape[1] || "";
    const host = shape[2] || "";
    const portText = shape[3];
    const rawPath = shape[4] || "";

    // WHATWG URL as a second gate: rsync:, with no password, query or fragment.
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return refuse(true);
    }
    if (parsed.protocol !== "rsync:") return refuse(true);
    if (parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return refuse(true);
    if (rawAccount.includes(":")) return refuse(true);

    const account = decode(rawAccount);
    if (!segmentOk(account)) return refuse(true);

    // A dotted IPv4 address only: names and IPv6 are refused.
    if (ipv4Parts(host) === null) return refuse(true);

    let port = "";
    if (portText !== undefined) {
      const value = Number(portText);
      if (!Number.isInteger(value) || value < 1 || value > 65535) return refuse(true);
      port = `:${value}`;
    }

    // `/module`, `/module/`, `/module/sub` or `/module/sub/`, checked on the raw text (before any
    // dot-segment resolution the URL parser would apply).
    let path = rawPath.slice(1);
    if (path.endsWith("/")) path = path.slice(0, -1);
    const raws = path.split("/");
    if (raws.length < 1 || raws.length > 2) return refuse(true);
    const segments = [];
    for (const segment of raws) {
      const decoded = decode(segment);
      if (!segmentOk(decoded)) return refuse(true);
      segments.push(decoded);
    }

    return {
      ok: true,
      url: `rsync://${account}@${host}${port}/${segments.join("/")}/`,
      hasSubfolder: segments.length === 2,
    };
  } catch {
    return refuse(typeof raw === "string" && raw.trim() !== "");
  }
}

// True for an address in Tailscale's 100.64.0.0/10 (the helper warns otherwise). Never throws.
function isTailscaleIp(host) {
  try {
    const parts = ipv4Parts(host);
    return parts !== null && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  } catch {
    return false;
  }
}

module.exports = { checkNasUrl, isTailscaleIp };
