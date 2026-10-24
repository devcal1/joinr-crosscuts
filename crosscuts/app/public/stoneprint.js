// The stone order and benchtop sheet prints (/stoneprint.html; docs/plans/m12-contracts.md
// sections 7 and 9.3). Gated by jobs.view or design.view (lib/pages.js), so Accounts and
// Scheduling can print a job's stone order or benchtop sheet without the Stone orders page.
//
//   ?id=N&rev=R     the frozen revision R as it was sent    GET /api/stone/:id/revisions/:rev
//   ?id=N           the current form; a draft, or a sent    GET /api/stone/:id
//                   order with unsent changes, prints as DRAFT – NOT SENT with no revision or date,
//                   and a changed sent order links "Print revision n as sent" on screen (section 12.20)
//
// A cancelled order (?id=N by its status, ?id=N&rev=R by the revision answer's status) carries a
// ruled CANCELLED box at the top, above the DRAFT one when both apply (section 7, 12.19). The
// benchtop sheet is always one page: long job lines and benchtop text get smaller type (fitLines,
// review B-m6), never cut.
//   ?sheet=<jobId>  the job's benchtop sheet                GET /api/job-records/:id/benchtop-sheet
//   ?sheet=blank    a blank benchtop sheet                  GET /api/stone/letterhead
//
// On screen the sheet sits on a white paper box with Print and Back; on paper only the sheet
// prints (A4 portrait, black on white; stoneprint.css). document.title names the sheet, so a
// saved PDF is named after it. Every value goes in through textContent. Classes are sp-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  function text(v) {
    return v == null ? "" : String(v).trim();
  }

  function setStatus(msg) {
    $("spStatus").textContent = msg || "";
  }

  function setBack(href, label) {
    const b = $("spBack");
    b.href = href;
    b.textContent = label || "Back";
  }

  function jobBack(jobId) {
    if (jobId != null && can("jobs.view")) setBack("/job.html?id=" + encodeURIComponent(jobId) + "#benchtops", "Back to the job");
  }

  // A sentence instead of a sheet (no access, not found, no connection).
  function refuse(msg) {
    const sheet = $("spSheet");
    sheet.classList.add("sp-sheet-error");
    sheet.replaceChildren(el("p", { class: "sp-error", text: msg }));
    $("spPrint").disabled = true;
    document.title = "Benchtop order print - Crosscuts";
  }

  function failText(e, what) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/not found/i.test(m)) return "There is no " + what + ".";
    if (/forbidden|permission|access|not allowed/i.test(m)) return "You don't have access to " + what + ".";
    return m || "That didn't load. Reload to try again.";
  }

  // ---- the letterhead: the banner, then the address, phone and email on one line ----------

  function letterhead(biz) {
    const b = biz || {};
    const name = text(b.tradingName) || text(b.legalName);
    const address = text(b.address).split(/\s*\n\s*/).filter(Boolean).join(", ");
    const line = [address, text(b.phone), text(b.email)].filter(Boolean).join("  ·  ");
    return [
      el("img", { class: "sp-banner", src: "/assets/invoice-letterhead.png", alt: name || "Letterhead" }),
      line ? el("p", { class: "sp-bizline", text: line }) : null,
    ];
  }

  // ---- the stone order ------------------------------------------------------------------------

  function kv(dl, label, value, strong) {
    dl.append(el("dt", { text: label }), el("dd", { class: strong ? "sp-strong" : null, text: text(value) }));
  }

  function block(title, rows) {
    const dl = el("dl", { class: "sp-kv" });
    for (const [label, value, strong] of rows) kv(dl, label, value, strong);
    return el("section", { class: "sp-block" }, el("h2", { class: "sp-blockh", text: title }), dl);
  }

  // p: {form, draft, cancelled, revision, sentDate, sentBy, biz}
  function stoneSheet(p) {
    const f = p.form || {};
    const out = letterhead(p.biz).filter(Boolean); // no address line: nothing (not the text "null")
    if (p.cancelled) out.push(el("p", { class: "sp-stamp sp-cancelled", text: "CANCELLED" }));
    if (p.draft) out.push(el("p", { class: "sp-stamp sp-draft", text: "DRAFT – NOT SENT" }));
    const meta = el("dl", { class: "sp-meta" });
    if (!p.draft) {
      meta.append(el("dt", { text: "Revision" }), el("dd", { text: String(p.revision) }));
      meta.append(el("dt", { text: "Date sent" }), el("dd", { text: fmtDate(p.sentDate) }));
    }
    out.push(el("div", { class: "sp-titlerow" },
      el("div", { class: "sp-titlebox" },
        el("h1", { class: "sp-h1", text: "Stone benchtop order" }),
        el("p", { class: "sp-to" }, el("span", { class: "sp-label", text: "To:" }), el("span", { class: "sp-toname", text: text(f.supplier) }))),
      p.draft ? null : meta));
    out.push(el("div", { class: "sp-blocks" },
      block("Job", [["Job reference", f.jobReference], ["Quote number", f.quoteNumber], ["Site address", f.siteAddress], ["Site access", f.siteAccess]]),
      block("Contacts", [["Our contact", f.ourContact], ["Our phone", f.ourPhone], ["Client", f.clientName], ["Client phone", f.clientPhone]]),
      block("Stone", [["Stone brand", f.brand], ["Colour", f.colour], ["Edge height", f.edgeHeight], ["Edge profile", f.edgeProfile]]),
      block("Dates", [["Cabinetry install", fmtDate(f.cabinetryInstallDate)], ["Measure / template", fmtDate(f.measureDate)],
        ["Requested benchtop install", fmtDate(f.requestedInstallDate), true]])));
    out.push(el("p", { class: "sp-mark", text: "Please mark all details, including cut-outs, on site before the final measure." }));
    out.push(el("section", { class: "sp-notes" }, el("h2", { class: "sp-blockh", text: "Notes" }), el("p", { class: "sp-pre", text: text(f.notes) })));
    out.push(el("div", { class: "sp-sign" },
      el("p", {}, el("span", { class: "sp-label", text: "Ordered by" }), el("span", { class: "sp-signval", text: p.draft ? "" : text(p.sentBy && p.sentBy.name) })),
      el("p", {}, el("span", { class: "sp-label", text: "Date" }), el("span", { class: "sp-signval", text: p.draft ? "" : fmtDate(p.sentDate) }))));
    return out;
  }

  function showStone(p, title) {
    const sheet = $("spSheet");
    sheet.className = "sp-sheet sp-order";
    sheet.setAttribute("aria-label", title);
    sheet.replaceChildren(...stoneSheet(p));
    document.title = title;
    $("spPrint").disabled = false;
  }

  // On screen only (the toolbar never prints): the last sent revision of a changed order.
  function revLink(idParam, n) {
    const a = el("a", {
      class: "hs-btn", id: "spRevLink",
      href: "/stoneprint.html?id=" + encodeURIComponent(idParam) + "&rev=" + encodeURIComponent(n),
      text: "Print revision " + n + " as sent",
    });
    $("spBack").after(a);
  }

  async function startOrder(idParam, revParam) {
    if (!/^[1-9]\d*$/.test(idParam || "") || (revParam != null && !/^[1-9]\d*$/.test(revParam))) {
      refuse("That isn't a stone order. Open one from its job's Benchtops section.");
      return;
    }
    if (can("design.view")) setBack("/stone.html?id=" + encodeURIComponent(idParam), "Back to the order");
    if (revParam != null) {
      let r;
      try {
        r = await api("/api/stone/" + encodeURIComponent(idParam) + "/revisions/" + encodeURIComponent(revParam));
      } catch (e) {
        refuse(failText(e, "revision " + revParam + " of stone order " + idParam));
        return;
      }
      if (!can("design.view")) jobBack(r.jobId);
      const ref = text(r.form && r.form.jobReference) || text(r.jobName);
      const off = r.status === "cancelled";
      showStone({ form: r.form, draft: false, cancelled: off, revision: r.revision, sentDate: r.sentDate, sentBy: r.sentBy, biz: r.business },
        "Benchtop order " + ref + " rev " + r.revision + (off ? " cancelled" : ""));
      setStatus("Revision " + r.revision + " as it was sent on " + fmtDate(r.sentDate) + "." + (off ? " The stone order has since been cancelled." : ""));
      return;
    }
    let o;
    try {
      o = await api("/api/stone/" + encodeURIComponent(idParam));
    } catch (e) {
      refuse(failText(e, "stone order " + idParam));
      return;
    }
    if (!can("design.view")) jobBack(o.jobId);
    const draft = !(o.revision > 0) || o.status === "draft" || !!o.changedSinceSent;
    const off = o.status === "cancelled";
    const ref = text(o.form && o.form.jobReference) || text(o.jobName);
    showStone({ form: o.form, draft, cancelled: off, revision: o.revision, sentDate: o.sentDate, sentBy: o.sentBy, biz: o.business },
      "Benchtop order " + ref + (draft ? " draft" : " rev " + o.revision) + (off ? " cancelled" : ""));
    const notes = [];
    if (off) notes.push("This stone order is cancelled.");
    if (draft && o.revision > 0) {
      // A changed sent order: the copy the supplier has is one click away, for anyone who can
      // print (Accounts and Scheduling have no Stone orders page to find Revisions on).
      revLink(idParam, o.revision);
      notes.push("It has changes not sent yet, so it prints as a draft. Print revision " + o.revision + " as sent prints the copy the supplier has.");
    } else if (draft) {
      notes.push("Not sent yet, so it prints as a draft.");
    }
    setStatus(notes.join(" "));
  }

  // ---- the benchtop sheet ---------------------------------------------------------------------

  // A labelled line to write on (empty on the blank sheet).
  function line(label, value, cls) {
    return el("div", { class: "sp-line" + (cls ? " " + cls : "") },
      el("span", { class: "sp-label", text: label }), el("span", { class: "sp-lineval", text: text(value) }));
  }

  function benchtopSheet(job, benchtopText, biz) {
    const j = job || {};
    const tops = Array.isArray(benchtopText) ? benchtopText.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [];
    const keyItem = (glyph, label) => el("li", {}, el("span", { class: "sp-glyph", text: glyph }), el("span", { text: label }));
    return [el("div", { class: "sp-bt" },
      ...letterhead(biz).filter(Boolean),
      el("div", { class: "sp-lines" },
        line("Job", j.name, "sp-line-wide"),
        line("Client", j.clientName),
        line("Quote", j.quoteNumber, "sp-line-right"),
        line("Site address", j.siteAddress, "sp-line-wide"),
        line("Benchtop", tops.join("; "), "sp-line-wide")),
      el("div", { class: "sp-draw", role: "img", "aria-label": "Drawing area" }),
      el("div", { class: "sp-key" },
        el("span", { class: "sp-label", text: "Edge key" }),
        el("ul", { class: "sp-keylist" }, keyItem("[ ]", "Square edge"), keyItem("//", "Rolled edge"), keyItem("X", "Raw edge"))))];
  }

  // One page, nothing cut (review B-m6): each line's value steps down from 11 pt until it takes no
  // more than about three lines (15 mm), to 7 pt at the least; if the sheet still runs past its
  // page (the drawing area at its least), the tallest value steps down again, to 5 pt. The sheet is
  // the same width on screen and on paper (186 mm inside the margins), so a measure on screen holds
  // for the print; it runs again once the banner has loaded and before printing.
  const PX_PER_MM = 96 / 25.4;
  const LINE_PT = 11;
  const LINE_MIN_PT = 7;
  const FLOOR_PT = 5;
  const LINE_CAP_MM = 15;

  function fitLines() {
    const bt = document.querySelector(".sp-bt");
    if (!bt) return;
    const vals = [...bt.querySelectorAll(".sp-lineval")];
    const cap = LINE_CAP_MM * PX_PER_MM;
    const size = (v) => parseFloat(v.style.fontSize) || LINE_PT;
    for (const v of vals) {
      v.style.fontSize = "";
      let pt = LINE_PT;
      while (v.offsetHeight > cap + 1 && pt > LINE_MIN_PT) {
        pt -= 0.5;
        v.style.fontSize = pt + "pt";
      }
    }
    for (let guard = 0; bt.scrollHeight > bt.clientHeight + 1 && guard < 200; guard++) {
      // The tallest value that can still get smaller goes down a step; short lines keep their size.
      const next = vals.filter((v) => size(v) > FLOOR_PT).sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
      if (!next) break;
      next.style.fontSize = size(next) - 0.5 + "pt";
    }
  }

  function showSheet(job, tops, biz, title) {
    const sheet = $("spSheet");
    sheet.className = "sp-sheet sp-sheet-bt";
    sheet.setAttribute("aria-label", title);
    sheet.replaceChildren(...benchtopSheet(job, tops, biz));
    document.title = title;
    $("spPrint").disabled = false;
    fitLines();
    const img = sheet.querySelector(".sp-banner");
    if (img && !img.complete) img.addEventListener("load", fitLines, { once: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLines);
  }

  window.addEventListener("beforeprint", fitLines);

  async function startSheet(param) {
    if (param === "blank") {
      if (can("design.view")) setBack("/stone.html", "Back to Benchtops");
      let r;
      try {
        r = await api("/api/stone/letterhead");
      } catch (e) {
        refuse(failText(e, "the letterhead"));
        return;
      }
      showSheet(null, [], r.business, "Benchtop sheet");
      setStatus("A blank sheet: fill in the job by hand.");
      return;
    }
    if (!/^[1-9]\d*$/.test(param || "")) {
      refuse("That isn't a job. Print a benchtop sheet from the job's Benchtops section.");
      return;
    }
    jobBack(param);
    let r;
    try {
      r = await api("/api/job-records/" + encodeURIComponent(param) + "/benchtop-sheet");
    } catch (e) {
      refuse(failText(e, "job " + param));
      return;
    }
    const name = text(r.job && r.job.name);
    showSheet(r.job, r.benchtopText, r.business, "Benchtop sheet" + (name ? " " + name : ""));
    setStatus("Draw the benchtops by hand, then add a photo of the sheet to the job's Photos.");
  }

  $("spPrint").addEventListener("click", () => window.print());

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    const q = new URLSearchParams(location.search);
    if (q.has("sheet")) startSheet(q.get("sheet"));
    else if (q.has("id")) startOrder(q.get("id"), q.has("rev") ? q.get("rev") : null);
    else refuse("Nothing to print. Open a stone order, or print a benchtop sheet from a job.");
  })();
})();
