// Route registration with a mandatory access declaration.
//
//   const r = defineRoutes("/api");
//   r.get("/workers", "board.view", handler);
//
// Every route gets requirePerm(access) prepended, so there is no way to
// register an /api route without saying who may call it. server.js calls
// assertAllRoutesGuarded(app) after mounting and refuses to start if any /api
// route slipped through un-guarded (e.g. a stray app.get("/api/x", ...)).
const express = require("express");

const registry = [];
const METHODS = ["get", "post", "patch", "put", "delete"];

// requirePerm is resolved from lib/auth.js on every request (not captured at
// require time), so the auth implementation can be swapped without touching
// any route file.
function lazyGuard(access) {
  const guard = function ccGuard(req, res, next) {
    return require("./auth").requirePerm(access)(req, res, next);
  };
  guard.__ccGuarded = true;
  guard.__ccAccess = access;
  return guard;
}

function defineRoutes(prefix) {
  const router = express.Router();
  // server.js mounts each router at the prefix it was defined with.
  router.ccPrefix = prefix;
  const api = { router };
  for (const method of METHODS) {
    api[method] = (path, access, ...handlers) => {
      if (access === undefined || access === null || typeof access === "function") {
        throw new Error(
          `${method.toUpperCase()} ${prefix}${path}: access must be declared (public, login, a key, or an array of keys)`
        );
      }
      if (handlers.length === 0) {
        throw new Error(`${method.toUpperCase()} ${prefix}${path}: no handler given`);
      }
      registry.push({ method: method.toUpperCase(), fullPath: prefix + path, access });
      router[method](path, lazyGuard(access), ...handlers);
      return api;
    };
  }
  return api;
}

function listRoutes() {
  return registry.map((r) => ({ ...r }));
}

// Recover the mount path of a router/middleware layer from its regexp (Express 4).
function mountPathOf(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return "";
  const src = layer.regexp ? layer.regexp.source : "";
  return src
    .replace("^\\/", "/")
    .replace("\\/?(?=\\/|$)", "")
    .replace(/\\\//g, "/")
    .replace(/\/$/, "");
}

function assertAllRoutesGuarded(app) {
  const problems = [];

  function walk(stack, base) {
    for (const layer of stack) {
      if (layer.route) {
        const fullPath = base + (typeof layer.route.path === "string" ? layer.route.path : String(layer.route.path));
        if (!(fullPath === "/api" || fullPath.startsWith("/api/"))) continue;
        const first = layer.route.stack[0];
        if (!first || !first.handle || first.handle.__ccGuarded !== true) {
          const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase()).join(",");
          problems.push(`${methods} ${fullPath}`);
        }
      } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, base + mountPathOf(layer));
      } else {
        // Plain middleware mounted under /api (app.use("/api/x", fn)) would
        // bypass the guard, so it is a violation too.
        const mp = base + mountPathOf(layer);
        if (mp === "/api" || mp.startsWith("/api/")) problems.push(`middleware mounted at ${mp}`);
      }
    }
  }

  const stack = app._router && app._router.stack ? app._router.stack : [];
  walk(stack, "");
  if (problems.length > 0) {
    throw new Error(
      "Un-guarded /api routes (register them with defineRoutes and an access value): " + problems.join("; ")
    );
  }
}

module.exports = { defineRoutes, assertAllRoutesGuarded, listRoutes };
