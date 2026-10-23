// Inventory page: list the farmer's lots, show how much of their value has a
// price floor, and send any lot to the LRP tool to find coverage.

(() => {
  const DATA = window.LRP_DATA;
  const $ = id => document.getElementById(id);

  const money = v => (v < 0 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
  const cwtPrice = v => "$" + v.toFixed(2);
  const pct = v => +(v * 100).toFixed(1) + "%";
  const longDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  // Lot names are typed by the user, so escape them before putting them in HTML.
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let editingId = null;

  function render() {
    const lots = Lots.load();
    const sum = SimHedge.inventorySummary(DATA, lots);
    renderSummary(sum);
    renderLots(lots);
    renderInterest(sum);
  }

  // Interest the farmer doesn't pay because premiums are billed at the end.
  // Uses an example 8% operating-loan rate.
  const EXAMPLE_RATE = 0.08;
  function renderInterest(sum) {
    const line = $("interest-line");
    const covered = sum.rows.filter(r => r.lot.coverage);
    let saved = 0;
    for (const { lot, s } of covered) {
      saved += s.premiumTotal * EXAMPLE_RATE * (lot.coverage.weeks / 52);
    }
    line.hidden = !covered.length;
    if (covered.length) {
      line.innerHTML = `On your covered lots: <strong>${money(sum.premiumTotal)}</strong> of premium billed at the end of coverage ` +
        `is about <strong>${money(saved)}</strong> of interest you don't pay (at an example 8% rate).`;
    }
  }

  // --- 1. Summary ------------------------------------------------------------
  function renderSummary(sum) {
    const bar = $("protect-bar");
    if (!sum.lots) {
      $("summary-headline").textContent = "Add the lots you plan to sell this year to see how much is protected.";
      $("summary-tiles").innerHTML = "";
      bar.hidden = true;
      return;
    }
    const share = sum.expectedValue ? sum.protectedValue / sum.expectedValue : 0;
    $("summary-headline").innerHTML = sum.protectedValue > 0
      ? `<strong>${money(sum.protectedValue)}</strong> of your <strong>${money(sum.expectedValue)}</strong> calf crop has a price floor.`
      : `None of your <strong>${money(sum.expectedValue)}</strong> calf crop has a price floor yet.`;
    $("summary-tiles").innerHTML = [
      tile("Head to sell", sum.head.toLocaleString(), `${sum.lots} lot${sum.lots === 1 ? "" : "s"}`),
      tile("Value at today's expected price", money(sum.expectedValue), `USDA prices from ${longDate(DATA.current.effectiveDate)}`),
      tile("Protected", pct(share), `${sum.coveredLots} of ${sum.lots} lots covered`),
      tile("Premium you'll owe", money(sum.premiumTotal), sum.premiumTotal ? "billed when each plan ends" : "no plans recorded"),
    ].join("");
    bar.hidden = false;
    $("protect-fill").style.width = (share * 100).toFixed(1) + "%";
  }

  function tile(label, value, sub) {
    return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  }

  // --- 2. Lots table ---------------------------------------------------------
  function renderLots(lots) {
    $("empty-state").hidden = lots.length > 0;
    $("lots-wrap").hidden = lots.length === 0;
    const warnings = [];

    $("lots-table").querySelector("tbody").innerHTML = lots.map(lot => {
      const name = `<strong>${esc(lot.name)}</strong>`;
      const actions = `<button type="button" class="link" data-edit="${lot.id}">Edit</button>
        <button type="button" class="link danger" data-delete="${lot.id}">Delete</button>`;

      if (lot.keep) {
        return `<tr class="kept">
          <td>${name}<div class="sub">Replacements, not for sale</div></td>
          <td>${lot.head}</td><td>–</td><td>Not sold</td><td>–</td><td>–</td>
          <td><span class="badge">Not insurable</span></td>
          <td class="actions">${actions}</td></tr>`;
      }

      const s = SimHedge.lotStatus(DATA, lot);
      s.warnings.forEach(w => warnings.push(`<strong>${esc(lot.name)}:</strong> ${w}`));
      const c = lot.coverage;
      const coverage = c
        ? `<span class="badge good">✓ Covered ${pct(c.level)}</span>
           <div class="sub">${cwtPrice(c.coverage)} floor · ends ${longDate(c.endDate)}<br>
           Premium ${money(s.premiumTotal)}, billed ${longDate(c.endDate)}</div>`
        : `<span class="badge bad">Unprotected</span>`;

      return `<tr>
        <td>${name}<div class="sub">${s.typeName}</div></td>
        <td>${lot.head}</td>
        <td>${lot.weight.toLocaleString()} lbs</td>
        <td>${longDate(lot.saleDate)}
          ${s.planWeeks ? `<div class="sub">${s.planWeeks}-week plan, ends ${longDate(s.planEnd)}</div>` : ""}
          ${s.tooEarly ? `<div class="sub warn-text">⚠ Sells too early: LRP won't pay</div>` : ""}</td>
        <td>${s.cwt.toLocaleString()} cwt</td>
        <td>${money(s.expectedValue)}</td>
        <td>${coverage}</td>
        <td class="actions">
          <a class="btn btn-small" href="lrp.html?lot=${encodeURIComponent(lot.id)}">${c ? "Change coverage" : "Find coverage"}</a>
          ${c ? `<button type="button" class="link" data-uncover="${lot.id}">Remove coverage</button>` : ""}
          ${actions}
        </td></tr>`;
    }).join("");

    $("lot-warnings").innerHTML = warnings.length
      ? `<div class="warn-box"><h3>Check these</h3><ul>${warnings.map(w => `<li>${w}</li>`).join("")}</ul></div>`
      : "";
  }

  // --- Add / edit form -------------------------------------------------------
  function defaultSaleDate() {
    const d = new Date(DATA.current.effectiveDate + "T12:00:00");
    d.setDate(d.getDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  // Feeder and fat cattle have different weight ranges.
  function syncWeightRange() {
    const cls = $("f-class").value, r = SimHedge.weightRange(cls), w = $("f-weight");
    w.min = r.min; w.max = r.max;
    $("f-weight-hint").textContent = SimHedge.isFat(cls) ? "Fat cattle: 1,000–1,800 lbs." : "Feeder cattle: 100–1,000 lbs.";
    const v = Number(w.value);
    if (!(v >= r.min && v <= r.max)) w.value = SimHedge.isFat(cls) ? 1350 : 550;
  }

  function resetForm() {
    editingId = null;
    $("lot-form").reset();
    $("f-date").value = defaultSaleDate();
    syncWeightRange();
    $("form-title").textContent = "Add a lot";
    $("f-submit").textContent = "Add lot";
    $("f-cancel").hidden = true;
  }

  function startEdit(id) {
    const lot = Lots.find(id);
    if (!lot) return;
    editingId = id;
    $("f-name").value = lot.name;
    $("f-class").value = lot.cattleClass;
    $("f-head").value = lot.head;
    $("f-weight").value = lot.weight;
    $("f-date").value = lot.saleDate;
    $("f-breakeven").value = lot.breakeven;
    $("f-keep").checked = !!lot.keep;
    syncWeightRange();
    $("form-title").textContent = `Edit "${lot.name}"`;
    $("f-submit").textContent = "Save changes";
    $("f-cancel").hidden = false;
    $("lot-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function onSubmit(e) {
    e.preventDefault();
    const old = editingId ? Lots.find(editingId) : null;
    const lot = {
      id: editingId || Lots.newId(),
      name: $("f-name").value.trim() || "Unnamed lot",
      cattleClass: $("f-class").value,
      head: Math.max(1, Math.round(Number($("f-head").value) || 1)),
      weight: Math.max(100, Number($("f-weight").value) || 100),   // out-of-range weights get a warning
      saleDate: $("f-date").value || defaultSaleDate(),
      breakeven: Math.max(0, Number($("f-breakeven").value) || 0),
      keep: $("f-keep").checked,
      coverage: null,
    };
    lot.coverage = Lots.fittingCoverage(old, lot);
    if (!Lots.upsert(lot)) showStorageProblem();
    resetForm();
    render();
  }

  function showStorageProblem() {
    const note = $("storage-note");
    note.classList.add("warn");
    note.textContent = "This browser isn't letting Sim Hedge save your lots (private window or strict privacy settings). They'll be lost when you leave the page.";
  }

  // --- Wiring ----------------------------------------------------------------
  function init() {
    if (!DATA) {
      document.querySelector("main").innerHTML = `<section class="card"><h2>Data missing</h2><p>Run <code>python3 site/tools/fetch_lrp.py</code> to download USDA LRP data.</p></section>`;
      return;
    }
    resetForm();
    $("lot-form").addEventListener("submit", onSubmit);
    $("f-class").addEventListener("change", syncWeightRange);
    $("f-cancel").addEventListener("click", () => { resetForm(); });
    $("load-example").addEventListener("click", () => {
      if (!Lots.save(Lots.exampleLots(DATA.current.effectiveDate))) showStorageProblem();
      render();
    });
    $("lots-table").addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.edit) startEdit(b.dataset.edit);
      if (b.dataset.delete) {
        // Two clicks to delete, so a slip of the finger doesn't lose a lot.
        if (b.dataset.armed) { Lots.remove(b.dataset.delete); render(); }
        else { b.dataset.armed = "1"; b.textContent = "Click again to delete"; }
      }
      if (b.dataset.uncover) {
        const lot = Lots.find(b.dataset.uncover);
        if (lot) { lot.coverage = null; Lots.upsert(lot); render(); }
      }
    });
    render();
  }
  init();
})();
