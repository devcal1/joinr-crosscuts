// Vehicles register (0.2.7, docs/plans/m28-contracts.md section 1). Lists /api/vehicles; Accounts
// (invoices.edit) adds and edits vehicles; the workshop manager (maintenance.manage) books, edits,
// confirms done and cancels bookings. Every piece of user text is set with textContent.
(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var KIND = { service: "Service", repair: "Repair", inspection: "Inspection", other: "Other" };
  function $(id) { return document.getElementById(id); }
  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.append(arguments[i]);
    return node;
  }
  function fmt(d) {
    if (!d) return "";
    var p = d.slice(0, 10).split("-");
    return Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0];
  }

  async function api(method, url, body) {
    var opts = { method: method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(url, opts);
    if (res.status === 204) return null;
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong (" + res.status + ")");
    return data;
  }

  var state = null;
  var editing = null; // vehicle being edited, or null for a new one
  var booking = null; // {vehicle, booking|null}

  function setStatus(t) { $("vhStatus").textContent = t || ""; }

  function expiryCell(label, x) {
    var td = el("td", { "data-label": label });
    if (!x) {
      td.append(el("span", { class: "vh-sub", text: "Not set" }));
      return td;
    }
    var words = fmt(x.date);
    var cls = "";
    if (x.expired) { words += " (expired)"; cls = "vh-expired"; }
    else if (x.soon) { words += " (in " + x.days + (x.days === 1 ? " day)" : " days)"); cls = "vh-soon"; }
    td.append(el("span", { class: cls, text: words }));
    return td;
  }

  function button(text, cls, onClick, label) {
    var b = el("button", { type: "button", class: "hs-btn" + (cls ? " " + cls : ""), text: text, "aria-label": label || null });
    b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    var rows = $("vhRows");
    rows.replaceChildren();
    $("vhAdd").hidden = !state.canEdit;
    state.vehicles.forEach(function (v) {
      var tr = el("tr", { class: v.active ? "" : "vh-inactive" });
      tr.append(el("td", { "data-label": "Vehicle" },
        el("span", { class: "vh-name", text: v.name }),
        el("span", { class: "vh-sub", text: [v.rego, v.makeModel, v.active ? "" : "Inactive"].filter(Boolean).join(" | ") })));
      tr.append(expiryCell("Rego expires", v.regoExpiry));
      tr.append(expiryCell("Insurance expires", v.insuranceExpiry));
      tr.append(el("td", { "data-label": "Insurer and policy", text: [v.insurer, v.policyNumber].filter(Boolean).join(", ") }));
      var next = v.bookings[0];
      var nb = el("td", { "data-label": "Next booking" });
      if (next) nb.append(el("span", { class: next.overdue ? "vh-expired" : "", text: KIND[next.kind] + " " + fmt(next.date) + (next.time ? " " + next.time : "") }));
      if (v.lastDone) nb.append(el("span", { class: "vh-sub", text: "Last done: " + KIND[v.lastDone.kind] + " " + fmt(v.lastDone.date) }));
      if (!next && !v.lastDone) nb.append(el("span", { class: "vh-sub", text: "None" }));
      tr.append(nb);
      var act = el("td", { class: "vh-actions" });
      if (state.canBook && v.active) act.append(button("Book", "hs-btn-primary", function () { openBooking(v, null); }, "Book " + v.name));
      if (state.canEdit) act.append(button("Edit", "", function () { openVehicle(v); }, "Edit " + v.name));
      tr.append(act);
      rows.append(tr);
    });
    $("vhWrap").hidden = !state.vehicles.length;
    $("vhEmpty").hidden = !!state.vehicles.length;
    $("vhEmpty").textContent = state.canEdit ? "No vehicles yet. Add the first one." : "No vehicles yet. Accounts adds them.";

    var brows = $("vhBookRows");
    brows.replaceChildren();
    state.bookings.forEach(function (b) {
      var v = state.vehicles.find(function (x) { return x.id === b.vehicleId; });
      var tr = el("tr");
      tr.append(el("td", { "data-label": "Date" }, el("span", { class: b.overdue ? "vh-expired" : "", text: fmt(b.date) + (b.time ? " " + b.time : "") + (b.overdue ? " (overdue)" : "") })));
      tr.append(el("td", { "data-label": "Vehicle", text: b.vehicleName }));
      tr.append(el("td", { "data-label": "Kind", text: KIND[b.kind] }));
      tr.append(el("td", { "data-label": "Where", text: b.place || "" }));
      tr.append(el("td", { "data-label": "Notes", text: b.notes || "" }));
      var act = el("td", { class: "vh-actions" });
      if (state.canBook) {
        act.append(button("Confirm done", "hs-btn-primary", function () { done(b); }, "Confirm " + KIND[b.kind] + " for " + b.vehicleName + " done"));
        act.append(button("Edit", "", function () { openBooking(v || { id: b.vehicleId, name: b.vehicleName }, b); }));
        act.append(button("Cancel booking", "hs-btn-stop", function () { cancel(b); }));
      }
      tr.append(act);
      brows.append(tr);
    });
    $("vhBookWrap").hidden = !state.bookings.length;
    $("vhBookEmpty").hidden = !!state.bookings.length;
  }

  async function load() {
    try {
      state = await api("GET", "/api/vehicles" + ($("vhAll").checked ? "?all=1" : ""));
      setStatus("");
      render();
    } catch (e) {
      setStatus("Couldn't load the vehicles: " + e.message);
    }
  }

  // --- the vehicle dialog ---
  function openVehicle(v) {
    editing = v;
    $("vhDlgTitle").textContent = v ? "Edit " + v.name : "Add vehicle";
    $("vName").value = v ? v.name : "";
    $("vRego").value = v ? v.rego : "";
    $("vMake").value = v ? v.makeModel : "";
    $("vRegoExp").value = v && v.regoExpiry ? v.regoExpiry.date : "";
    $("vInsExp").value = v && v.insuranceExpiry ? v.insuranceExpiry.date : "";
    $("vInsurer").value = v ? v.insurer : "";
    $("vPolicy").value = v ? v.policyNumber : "";
    $("vNotes").value = v ? v.notes : "";
    $("vActive").checked = v ? v.active : true;
    $("vActiveBox").hidden = !v;
    $("vError").textContent = "";
    $("vhDlg").showModal();
    $("vName").focus();
  }
  $("vhAdd").addEventListener("click", function () { openVehicle(null); });
  $("vCancel").addEventListener("click", function () { $("vhDlg").close(); });
  $("vhForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = {
      name: $("vName").value,
      rego: $("vRego").value,
      makeModel: $("vMake").value,
      regoExpiry: $("vRegoExp").value || null,
      insuranceExpiry: $("vInsExp").value || null,
      insurer: $("vInsurer").value,
      policyNumber: $("vPolicy").value,
      notes: $("vNotes").value,
    };
    if (editing) body.active = $("vActive").checked;
    $("vSave").disabled = true;
    try {
      if (editing) await api("PATCH", "/api/vehicles/" + editing.id, body);
      else await api("POST", "/api/vehicles", body);
      $("vhDlg").close();
      await load();
    } catch (err) {
      $("vError").textContent = err.message;
    } finally {
      $("vSave").disabled = false;
    }
  });

  // --- the booking dialog ---
  function openBooking(v, b) {
    booking = { vehicle: v, booking: b };
    $("vbDlgTitle").textContent = b ? "Edit booking" : "Book";
    $("vbWhat").textContent = v.name;
    $("bKind").value = b ? b.kind : "service";
    $("bDate").value = b ? b.date : "";
    $("bTime").value = b && b.time ? b.time : "";
    $("bPlace").value = b ? b.place : "";
    $("bNotes").value = b ? b.notes : "";
    $("bError").textContent = "";
    $("vbDlg").showModal();
    $("bDate").focus();
  }
  $("bCancel").addEventListener("click", function () { $("vbDlg").close(); });
  $("vbForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = { kind: $("bKind").value, date: $("bDate").value, time: $("bTime").value || null, place: $("bPlace").value, notes: $("bNotes").value };
    $("bSave").disabled = true;
    try {
      if (booking.booking) await api("PATCH", "/api/vehicle-bookings/" + booking.booking.id, body);
      else await api("POST", "/api/vehicles/" + booking.vehicle.id + "/bookings", body);
      $("vbDlg").close();
      await load();
    } catch (err) {
      $("bError").textContent = err.message;
    } finally {
      $("bSave").disabled = false;
    }
  });

  async function done(b) {
    try {
      await api("POST", "/api/vehicle-bookings/" + b.id + "/done", { done: true });
      setStatus(KIND[b.kind] + " for " + b.vehicleName + " confirmed done.");
      await load();
    } catch (e) {
      setStatus(e.message);
    }
  }
  async function cancel(b) {
    if (!confirm("Cancel the " + KIND[b.kind].toLowerCase() + " for " + b.vehicleName + " on " + fmt(b.date) + "?")) return;
    try {
      await api("DELETE", "/api/vehicle-bookings/" + b.id);
      await load();
    } catch (e) {
      setStatus(e.message);
    }
  }

  $("vhAll").addEventListener("change", load);
  load();
})();
