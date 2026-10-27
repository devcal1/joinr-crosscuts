// Confirm complete (0.2.5, docs/plans/m26-contracts.md section 3), on the job page and the project
// page. Shown while a job is installed (Finish week) and not yet complete: who may confirm (the
// project owner, or an admin) gets Confirm complete, which completes the job and makes the final
// invoice due; open issues are a warning, not a block. Everyone else sees that it is waiting.
// Fills <div id="confirmComplete">; ?id=N is the job. Text only.
(function () {
  "use strict";

  const box = document.getElementById("confirmComplete");
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!box || !Number.isInteger(jobId) || jobId <= 0) return;

  function day(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : "";
  }

  async function render() {
    let s;
    try {
      s = await api(`/api/job-records/${jobId}/completion`);
    } catch (e) {
      return;
    }
    if (!s.awaitingConfirm) {
      box.hidden = true;
      return;
    }
    box.replaceChildren();
    const text = document.createElement("span");
    text.textContent = `Installed ${day(s.installedDate)}. Waiting for the project manager to confirm complete.`;
    box.append(text);
    if (s.openIssues) {
      const w = document.createElement("span");
      w.className = "jo-confirm-warn";
      w.textContent = ` ${s.openIssues} open ${s.openIssues === 1 ? "issue" : "issues"}.`;
      box.append(w);
    }
    if (s.canConfirm) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hs-btn hs-btn-primary";
      btn.textContent = "Confirm complete";
      const msg = document.createElement("span");
      msg.setAttribute("role", "status");
      btn.addEventListener("click", async () => {
        const warn = s.openIssues ? `\n\nThis job has ${s.openIssues} open ${s.openIssues === 1 ? "issue" : "issues"}.` : "";
        if (!confirm(`Confirm this job complete? The final invoice falls due.${warn}`)) return;
        btn.disabled = true;
        try {
          await api(`/api/job-records/${jobId}/confirm-complete`, { method: "POST", body: "{}" });
          location.reload();
        } catch (e) {
          msg.textContent = " " + e.message;
          btn.disabled = false;
        }
      });
      box.append(" ", btn, msg);
    }
    box.hidden = false;
    if (location.hash === "#confirmComplete") box.scrollIntoView({ block: "center" });
  }

  render();
})();
