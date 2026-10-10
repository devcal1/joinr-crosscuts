// WAVE 0 PASS-THROUGH STUBS. T1 replaces this whole file with the real
// implementation; the export names and signatures are fixed by
// docs/plans/m1-contracts.md ("Auth"). Until then nothing is enforced.
function authenticate(req, res, next) {
  req.user = null;
  req.session = null;
  next();
}

// access: 'public' | 'login' | a feature key | an array of keys.
function requirePerm(access) {
  return function passThroughPerm(req, res, next) {
    next();
  };
}

function pageGate(req, res, next) {
  next();
}

function originCheck(req, res, next) {
  next();
}

function requireLogin(req, res, next) {
  next();
}

module.exports = { authenticate, requirePerm, pageGate, originCheck, requireLogin };
