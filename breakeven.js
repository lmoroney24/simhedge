// Breakeven page: itemized all-in costs -> breakeven price per cwt.
// Inputs are remembered in this browser only, and can be sent to the LRP tool.

(() => {
  const DATA = window.LRP_DATA;
  const $ = id => document.getElementById(id);
  const KEY = "simhedge.breakeven.v1";

  const money = v => (v < 0 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
  const cwtPrice = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  const longDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // Cost lines: input id -> label in the results table
  const LINES = {
    "c-cow": "Cow herd costs", "c-feed": "Feed, hay & supplements", "c-pasture": "Pasture or grazing rent",
    "c-vet": "Vet & medicine", "c-labor": "Labor", "c-equip": "Fuel, repairs & equipment",
    "c-market": "Marketing", "c-other": "Other",
  };
  const FIELDS = ["b-class", "b-head", "b-weight", "b-date", "c-purchase", ...Object.keys(LINES),
    "b-rate", "b-months", "b-death", "b-profit"];
  let per = "head";
  let calculated = null;   // the inputs as of the last "Calculate breakeven" press
  let lastResult = null;   // what gets sent to the LRP tool or saved on a lot

  // Example: 40-head cow-calf herd selling 550-lb steers (made-up, labeled on the page)
  const EXAMPLE = {
    "b-class": "steers", "b-head": 40, "b-weight": 550, "c-purchase": "", "c-cow": 1059, "c-feed": 60,
    "c-pasture": "", "c-vet": 25, "c-labor": 40, "c-equip": 30, "c-market": 45, "c-other": "",
    "b-rate": 8, "b-months": 7, "b-death": 1.5,
  };

  // --- Saving inputs in this browser ------------------------------------------
  function save() {
    try {
      const values = {};
      FIELDS.forEach(id => { values[id] = $(id).value; });
      localStorage.setItem(KEY, JSON.stringify({ values, per, result: lastResult }));
    } catch { /* storage blocked: the page still works, it just won't remember */ }
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  }

  // --- Reading the form ---------------------------------------------------------
  const num = id => Number($(id).value) || 0;

  function readInputs() {
    const cattleClass = $("b-class").value;
    const costs = {};
    for (const id of Object.keys(LINES)) costs[id] = num(id);
    return {
      cattleClass,
      head: Math.max(1, Math.round(num("b-head")) || 1),
      weight: SimHedge.clampWeight(cattleClass, $("b-weight").value),
      saleDate: $("b-date").value,
      costs, purchase: num("c-purchase"), per,
      interestRate: num("b-rate") / 100, months: num("b-months"), deathLossPct: num("b-death"),
    };
  }

  // --- Calculate ----------------------------------------------------------------
  // The result only changes when the farmer presses "Calculate breakeven".
  function calculate() {
    calculated = readInputs();
    const d = SimHedge.breakevenDetail(calculated);
    lastResult = d.totalCost > 0
      ? { perCwt: Math.round(d.perCwt * 100) / 100, cattleClass: calculated.cattleClass, head: calculated.head,
          weight: calculated.weight, saleDate: calculated.saleDate }
      : null;
    $("b-stale").hidden = true;
    $("b-lot-msg").hidden = true;
    save();
    render();
  }

  // Any change to the inputs after calculating: remember it, and say the result is out of date.
  function onInputChange() {
    renderCowHelp();
    if (calculated) $("b-stale").hidden = false;
    save();
  }

  // --- Render -----------------------------------------------------------------
  function render() {
    const inp = calculated;
    const d = inp && SimHedge.breakevenDetail(inp);
    const hasCosts = !!d && d.totalCost > 0;
    $("b-empty").hidden = hasCosts;
    $("b-out").hidden = !hasCosts;
    $("b-empty").innerHTML = calculated
      ? "Enter at least one cost above, then press <strong>Calculate breakeven</strong>."
      : "Enter your costs above, then press <strong>Calculate breakeven</strong>.";
    renderCowHelp();
    if (!hasCosts) return;

    $("b-tiles").innerHTML = [
      tile("Breakeven", cwtPrice(d.perCwt) + " /cwt", "the price that covers all your costs"),
      tile("Cost per head sold", money(d.perHead), `${(Math.round(d.soldHead * 10) / 10).toLocaleString()} of ${inp.head} head sold`),
      tile("Total all-in cost", money(d.totalCost), "for the whole group"),
    ].join("");

    // Where the money goes
    const rows = [];
    if (d.purchaseTotal) rows.push(["Purchase price", d.purchaseTotal]);
    for (const l of d.lines) if (l.total) rows.push([LINES[l.name], l.total]);
    if (d.interest) rows.push([`Interest (${(inp.interestRate * 100).toFixed(2).replace(/\.?0+$/, "")}% for ${inp.months} months)`, d.interest]);
    rows.sort((a, b) => b[1] - a[1]);
    $("b-table").querySelector("tbody").innerHTML = rows.map(([name, total]) => {
      const share = total / d.totalCost;
      return `<tr><td>${name}</td><td>${money(total / d.soldHead)}</td><td>${cwtPrice(total / d.soldCwt)}</td>
        <td><span class="share-bar"><i style="width:${(share * 100).toFixed(1)}%"></i></span> ${Math.round(share * 100)}%</td></tr>`;
    }).join("") + `<tr class="total-row"><td>Total</td><td>${money(d.perHead)}</td><td>${cwtPrice(d.perCwt)}</td><td>100%</td></tr>`;

    // Profit target
    const profit = num("b-profit");
    $("b-target-line").innerHTML = `To make <strong>${money(profit)}</strong> per head, you need to sell for ` +
      `<strong>${cwtPrice(SimHedge.targetPrice(d, profit, inp.weight))}/cwt</strong>.`;

    // Today's market for these cattle
    const code = SimHedge.typeCode(inp.cattleClass, inp.weight);
    const match = SimHedge.matchEndorsement(SimHedge.currentOptions(DATA, code), inp.saleDate);
    if (match) {
      const exp = match.levels[0].expEnd, gap = exp - d.perCwt;
      $("b-market").innerHTML = `<strong>Today's market expects ${cwtPrice(exp)}/cwt</strong> for these cattle around ` +
        `${longDate(match.endDate)}: <strong>${cwtPrice(Math.abs(gap))} ${gap >= 0 ? "above" : "below"}</strong> your breakeven. ` +
        `This is USDA's estimate from ${longDate(DATA.current.effectiveDate)}, not a prediction.`;
    }
    renderLotPicker();
  }

  // --- Save the breakeven to a lot (shows up on the Inventory page) -----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CLASS_NAMES = { steers: "steers", heifers: "heifers", fat: "fat cattle" };

  function renderLotPicker(selectId) {
    const lots = Lots.load().filter(l => !l.keep);
    $("b-existing").hidden = lots.length === 0;
    const sel = $("b-lot-select"), keep = selectId || sel.value;
    sel.innerHTML = lots.map(l => `<option value="${esc(l.id)}">${esc(l.name)} (${l.head} ${CLASS_NAMES[l.cattleClass] || l.cattleClass})</option>`).join("");
    if (lots.some(l => l.id === keep)) sel.value = keep;
  }

  function lotMessage(html, warn) {
    const msg = $("b-lot-msg");
    msg.hidden = false;
    msg.classList.toggle("warn", !!warn);
    msg.innerHTML = html;
  }

  const SEE_INVENTORY = ` <a href="inventory.html">See your inventory →</a>`;
  const STORAGE_PROBLEM = "This browser isn't letting Sim Hedge save (private window or strict privacy settings).";

  function saveToExistingLot() {
    const lot = Lots.find($("b-lot-select").value);
    if (!lot || !lastResult) return;
    lot.breakeven = lastResult.perCwt;
    if (!Lots.upsert(lot)) { lotMessage(STORAGE_PROBLEM, true); return; }
    let text = `✓ Saved ${cwtPrice(lastResult.perCwt)}/cwt as the breakeven for "${esc(lot.name)}".`;
    if (SimHedge.isFat(lot.cattleClass) !== SimHedge.isFat(lastResult.cattleClass)) {
      text += ` Note: this lot is ${SimHedge.isFat(lot.cattleClass) ? "fat" : "feeder"} cattle, but you calculated for ${SimHedge.isFat(lastResult.cattleClass) ? "fat" : "feeder"} cattle.`;
    }
    lotMessage(text + SEE_INVENTORY);
    renderLotPicker(lot.id);
  }

  function saveToNewLot() {
    const name = $("b-lot-name").value.trim();
    if (!name) { lotMessage("Give the new lot a name first.", true); $("b-lot-name").focus(); return; }
    if (!lastResult) return;
    const r = lastResult;
    const lot = {
      id: Lots.newId(), name, cattleClass: r.cattleClass, head: r.head, weight: r.weight,
      saleDate: r.saleDate || defaultSaleDate(), breakeven: r.perCwt, keep: false, coverage: null,
    };
    if (!Lots.upsert(lot)) { lotMessage(STORAGE_PROBLEM, true); return; }
    $("b-lot-name").value = "";
    lotMessage(`✓ Created "${esc(name)}" (${r.head} head, breakeven ${cwtPrice(r.perCwt)}/cwt).` +
      ` <a href="lrp.html?lot=${encodeURIComponent(lot.id)}">Find LRP coverage for it →</a>` + SEE_INVENTORY);
    renderLotPicker(lot.id);
  }

  function tile(label, value, sub) {
    return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  }

  // Cow herd cost helper: yearly cost per cow ÷ share of cows that wean a calf
  function renderCowHelp() {
    const perCalf = SimHedge.cowCostPerCalf(num("cow-cost"), num("cow-weaned"));
    $("cow-result").innerHTML = perCalf > 0
      ? `Cow herd cost per calf: <strong>${money(perCalf)}</strong>. <button type="button" class="btn btn-small" id="cow-apply">Use this number</button>`
      : "Enter your yearly cost per cow.";
  }

  // --- Wiring ---------------------------------------------------------------
  function setPer(value) {
    per = value;
    document.querySelectorAll("#b-per [data-per]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.per === per)));
  }

  function syncWeightRange() {
    const cls = $("b-class").value, r = SimHedge.weightRange(cls), w = $("b-weight");
    w.min = r.min; w.max = r.max;
    $("b-weight-hint").textContent = SimHedge.isFat(cls) ? "Fat cattle: 1,000–1,800 lbs." : "Feeder cattle: 100–1,000 lbs.";
    const v = Number(w.value);
    if (!(v >= r.min && v <= r.max)) w.value = SimHedge.isFat(cls) ? 1350 : 550;
  }

  function defaultSaleDate() {
    const d = new Date(DATA.current.effectiveDate + "T12:00:00");
    d.setDate(d.getDate() + 120);
    return d.toISOString().slice(0, 10);
  }

  function init() {
    if (!DATA) return;
    $("b-date").value = defaultSaleDate();

    const saved = load();
    if (saved && saved.values) {
      for (const [id, v] of Object.entries(saved.values)) if ($(id) && v !== undefined) $(id).value = v;
      setPer(saved.per || "head");
    }
    syncWeightRange();

    document.querySelectorAll("#b-form, #b-cost-form, .b-extra, #cow-help").forEach(el =>
      el.addEventListener("input", onInputChange));
    $("b-class").addEventListener("change", () => { syncWeightRange(); onInputChange(); });
    $("b-profit").addEventListener("input", () => { save(); render(); });
    $("b-calc").addEventListener("click", calculate);

    // Switching per head <-> whole group converts the amounts already typed in
    $("b-per").addEventListener("click", e => {
      const b = e.target.closest("[data-per]");
      if (!b || b.dataset.per === per) return;
      const head = Math.max(1, Math.round(num("b-head")) || 1);
      const factor = b.dataset.per === "total" ? head : 1 / head;
      document.querySelectorAll("[data-cost]").forEach(i => {
        if (i.value !== "") i.value = Math.round(Number(i.value) * factor);
      });
      setPer(b.dataset.per);
      onInputChange();
    });

    $("b-example").addEventListener("click", () => {
      setPer("head");
      for (const [id, v] of Object.entries(EXAMPLE)) $(id).value = v;
      syncWeightRange();
      $("b-example-note").hidden = false;
      onInputChange();
    });
    $("b-clear").addEventListener("click", () => {
      document.querySelectorAll("[data-cost]").forEach(i => { i.value = ""; });
      $("b-example-note").hidden = true;
      onInputChange();
    });

    $("cow-help-btn").addEventListener("click", () => { $("cow-help").hidden = !$("cow-help").hidden; renderCowHelp(); });
    $("cow-help").addEventListener("click", e => {
      if (e.target.id !== "cow-apply") return;
      const perCalf = SimHedge.cowCostPerCalf(num("cow-cost"), num("cow-weaned"));
      const head = Math.max(1, Math.round(num("b-head")) || 1);
      $("c-cow").value = Math.round(per === "total" ? perCalf * head : perCalf);
      $("cow-help").hidden = true;
      onInputChange();
    });

    // Send the breakeven (and the cattle) to the LRP tool
    $("b-use").addEventListener("click", () => { save(); location.href = "lrp.html?from=breakeven"; });

    // Save the breakeven to an existing lot or a new one
    $("b-lot-update").addEventListener("click", saveToExistingLot);
    $("b-lot-new").addEventListener("click", saveToNewLot);
    $("b-lot-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveToNewLot(); } });

    // Coming back to the page: show the last result again
    if (saved && saved.result) calculate(); else render();
  }
  init();
})();
