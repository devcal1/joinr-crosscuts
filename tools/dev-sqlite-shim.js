// Local-dev only. better-sqlite3 won't build on the Windows dev box, so this
// maps the slice of its API the app uses onto node:sqlite (Node >= 22.5).
// It lives outside crosscuts/app so it never enters the Docker build context.
//
//   cd crosscuts/app
//   DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config \
//     node -r ../../tools/dev-sqlite-shim.js server.js
//
// Supported: new Database(path), .pragma(str, {simple}), .exec, .prepare()
// .run/.get/.all (positional, array and named params), .transaction(fn)
// (nestable via savepoints; .immediate/.deferred/.exclusive variants too),
// .close, .name, .open, .inTransaction.
//
// DEV_STUB_SHARP=1 additionally replaces require("sharp") with a stub, for
// machines where sharp's native binary won't load. Not needed normally.
const Module = require("module");
const { DatabaseSync } = require("node:sqlite");

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

// better-sqlite3 accepts (a, b), ([a, b]) and ({name}) -- normalise to a spread
// list for node:sqlite. Plain objects are named params and stay as one arg.
function normaliseArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

class Statement {
  constructor(stmt) {
    this._stmt = stmt;
  }
  run(...args) {
    return this._stmt.run(...normaliseArgs(args));
  }
  get(...args) {
    return this._stmt.get(...normaliseArgs(args));
  }
  all(...args) {
    return this._stmt.all(...normaliseArgs(args));
  }
  iterate(...args) {
    return this._stmt.iterate(...normaliseArgs(args));
  }
}

class Database {
  constructor(file) {
    this._db = new DatabaseSync(file);
    this.name = file;
    this._depth = 0;
  }
  get open() {
    return this._db.isOpen !== false;
  }
  get inTransaction() {
    return this._depth > 0;
  }
  pragma(str, opts) {
    const rows = this._db.prepare(`PRAGMA ${str}`).all();
    if (opts && opts.simple) {
      if (rows.length === 0) return undefined;
      const first = rows[0];
      return first[Object.keys(first)[0]];
    }
    return rows;
  }
  exec(sql) {
    this._db.exec(sql);
    return this;
  }
  prepare(sql) {
    return new Statement(this._db.prepare(sql));
  }
  transaction(fn) {
    const self = this;
    const make = (begin) =>
      function transactionWrapper(...args) {
        const nested = self._depth > 0;
        const sp = `sp_${self._depth}`;
        self._db.exec(nested ? `SAVEPOINT ${sp}` : begin);
        self._depth++;
        try {
          const result = fn.apply(this, args);
          self._depth--;
          self._db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
          return result;
        } catch (err) {
          self._depth--;
          try {
            self._db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
          } catch {
            // already rolled back by SQLite
          }
          throw err;
        }
      };
    const wrapper = make("BEGIN");
    wrapper.deferred = make("BEGIN DEFERRED");
    wrapper.immediate = make("BEGIN IMMEDIATE");
    wrapper.exclusive = make("BEGIN EXCLUSIVE");
    return wrapper;
  }
  close() {
    this._db.close();
    return this;
  }
}

let stubSharp = null;
if (process.env.DEV_STUB_SHARP === "1") {
  stubSharp = function sharp() {
    throw new Error("sharp is stubbed (DEV_STUB_SHARP=1); photo upload is unavailable");
  };
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "better-sqlite3") return Database;
  if (request === "sharp" && stubSharp) return stubSharp;
  return originalLoad.call(this, request, parent, isMain);
};

// Also make plain resolution succeed if anything resolves the module path
// without loading it (e.g. require.resolve).
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "better-sqlite3") return __filename;
  return originalResolve.call(this, request, ...rest);
};

module.exports = Database;
