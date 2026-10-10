// HTTP errors for the shared libraries and routes. See docs/plans/m3-contracts.md
// section 2. Library functions throw these; routes map them with sendError.
//
//   throw conflict("Someone else has moved this job", { stage: job.stage });
//   ...
//   catch (e) { sendError(res, e, "[orders]"); }

class HttpError extends Error {
  // `extra` is an optional plain object merged into the response body.
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra && typeof extra === "object") this.extra = extra;
  }
}

const bad = (msg) => new HttpError(400, msg);
const forbidden = () => new HttpError(403, "Forbidden");
const notFound = () => new HttpError(404, "Not found");
const conflict = (msg, extra) => new HttpError(409, msg, extra);

// Duck-typed on `status`, so it also maps invoices.HttpError and the local
// class in routes/jobs.js. Anything that is not a 4xx is logged and hidden.
function sendError(res, e, label) {
  if (e && typeof e.status === "number" && e.status >= 400 && e.status <= 499) {
    return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
  }
  console.error(label, e);
  return res.status(500).json({ error: "Server error" });
}

// True when the logged-in user's effective permissions (a Set or an array)
// include `key`. No user: false.
function can(req, key) {
  if (!req || !req.user) return false;
  const perms = req.user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

module.exports = { HttpError, bad, forbidden, notFound, conflict, sendError, can };
