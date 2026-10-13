// Drawer sizes (docs/plans/m11-contracts.md section 4.1): the one home of the drawer brands, their
// heights and the runner lengths, shared by the server (lib/drawers.js requires it) and the pages
// (<script src="/drawers.js"> sets window.Drawers). No dependencies, no DOM. A new brand or size
// takes a release (m11-plan lead's default 2); nothing in the database checks these values.
//
// Counts everywhere are [{height, length, qty}]: height and length in mm, qty a whole number from
// 1 to 999. A zero count is simply absent.
(function (root) {
  "use strict";

  var BRANDS = [
    {
      id: "edge",
      label: "EDGE",
      heights: [
        { mm: 93, label: "Low 93" },
        { mm: 126, label: "Mid 126" },
        { mm: 174, label: "High 174" },
        { mm: 238, label: "Super High 238" },
      ],
    },
    {
      id: "dtc",
      label: "DTC",
      heights: [
        { mm: 95, label: "95" },
        { mm: 127, label: "127" },
        { mm: 178, label: "178" },
        { mm: 209, label: "209" },
      ],
    },
  ];
  var LENGTHS = [300, 350, 400, 450, 500, 550, 600];
  var QTY_MAX = 999;
  var DESCRIPTION_MAX = 500;

  function brand(id) {
    for (var i = 0; i < BRANDS.length; i++) if (BRANDS[i].id === id) return BRANDS[i];
    return null;
  }

  function heightOf(b, mm) {
    for (var i = 0; i < b.heights.length; i++) if (b.heights[i].mm === mm) return b.heights[i];
    return null;
  }

  function validSize(brandId, height, length) {
    var b = brand(brandId);
    return !!b && !!heightOf(b, height) && LENGTHS.indexOf(length) !== -1;
  }

  // Counts in brand order: by height (the brand's order), then length.
  function sorted(brandId, counts) {
    var b = brand(brandId);
    var hIndex = function (h) {
      if (!b) return h;
      for (var i = 0; i < b.heights.length; i++) if (b.heights[i].mm === h) return i;
      return b.heights.length + h;
    };
    return (counts || []).slice().sort(function (x, y) {
      return hIndex(x.height) - hIndex(y.height) || x.length - y.length;
    });
  }

  // "Drawers (EDGE): 6 × Mid 126/500, 4 × High 174/500", cut to 500 characters with "…".
  function describe(brandId, counts) {
    var b = brand(brandId);
    var head = "Drawers (" + (b ? b.label : String(brandId)) + ")";
    var parts = sorted(brandId, counts).map(function (c) {
      var h = b && heightOf(b, c.height);
      return c.qty + " × " + (h ? h.label : String(c.height)) + "/" + c.length;
    });
    var s = parts.length ? head + ": " + parts.join(", ") : head;
    return s.length > DESCRIPTION_MAX ? s.slice(0, DESCRIPTION_MAX - 1) + "…" : s;
  }

  function total(counts) {
    var n = 0;
    (counts || []).forEach(function (c) { n += Number(c.qty) || 0; });
    return n;
  }

  // {[height]: {[length]: qty}}
  function grid(counts) {
    var g = {};
    (counts || []).forEach(function (c) {
      if (!g[c.height]) g[c.height] = {};
      g[c.height][c.length] = (g[c.height][c.length] || 0) + c.qty;
    });
    return g;
  }

  // Adds several count lists into one (the totals row), in brand order.
  function sum(brandId, lists) {
    var byKey = {};
    (lists || []).forEach(function (counts) {
      (counts || []).forEach(function (c) {
        var k = c.height + "x" + c.length;
        if (!byKey[k]) byKey[k] = { height: c.height, length: c.length, qty: 0 };
        byKey[k].qty += c.qty;
      });
    });
    return sorted(brandId, Object.keys(byKey).map(function (k) { return byKey[k]; }));
  }

  var Drawers = {
    BRANDS: BRANDS,
    LENGTHS: LENGTHS,
    QTY_MAX: QTY_MAX,
    brand: brand,
    validSize: validSize,
    sorted: sorted,
    describe: describe,
    total: total,
    grid: grid,
    sum: sum,
  };

  if (typeof module === "object" && module.exports) module.exports = Drawers;
  else root.Drawers = Drawers;
})(typeof window !== "undefined" ? window : this);
