// The "New from Joinr" inbox: list, accept, link, ignore (m6-contracts.md sections 2 and 5).
// Scaffold (M6 · 2.2): stubs; Wave 1 B builds them. Signatures are binding.
const { HttpError } = require("./httperror");

const notBuilt = () => {
  throw new HttpError(501, "Not built");
};

function list(db, user, opts) { notBuilt(); }
function get(db, user, id) { notBuilt(); }
function matches(db, id) { notBuilt(); }
function accept(db, req, id) { notBuilt(); }
function link(db, req, id, jobId) { notBuilt(); }
function ignore(db, req, id) { notBuilt(); }
function acknowledge(db, req, id) { notBuilt(); }
function forJob(db, user, jobId) { notBuilt(); }

module.exports = { list, get, matches, accept, link, ignore, acknowledge, forJob };
