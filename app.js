// Sim Hedge page logic: reads the form, runs calc.js, and draws everything.

(() => {
  const DATA = window.LRP_DATA;
  const $ = id => document.getElementById(id);

  // --- Formatting ----------------------------------------------------------
  const money = v => (v < 0 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
  const signed = v => (v > 0 ? "+" : "") + money(v);
  const cwtPrice = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  const pct = v => +(v * 100).toFixed(1) + "%";
  // USDA subsidy is set in 5-point steps (35%, 40%, 45%...); the published
  // premiums are rounded to the cent, so we round the computed share to match.
  const subsidyPct = plan => Math.round(SimHedge.subsidyShare(plan) * 20) * 5 + "%";
  const longDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const shortDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // --- State ---------------------------------------------------------------
  let selectedLevel = null;   // coverage level picked by the farmer; null = use the recommendation
  let selectedWeeks = null;   // plan length picked by the farmer; null = the one that fits the sale date
  let unit = "total";         // how money is shown: "total", "head" or "cwt"
  let activeLot = null;       // lot opened from the inventory page (?lot=...), if any
  let lastPlan = null, lastMatch = null;

  function readHerd() {
    const budget = Number($("budget").value);
    return {
      cattleClass: $("cattle-class").value,
      head: Math.max(1, Number($("head").value) || 1),
      weight: SimHedge.clampWeight($("cattle-class").value, $("weight").value),
      rawWeight: Number($("weight").value) || 0,
      saleDate: $("sale-date").value,
      breakeven: Number($("breakeven").value) || 0,
      basis: 0,   // local basis was removed from the form; the sale price is taken as the index price
      budgetPerHead: budget > 0 ? budget : null,
    };
  }
  const tolerance = () => document.querySelector("input[name=tolerance]:checked").value;

  // --- Money in the chosen unit ---------------------------------------------
  // Every amount is calculated for the whole herd, then divided for display.
  function per(herd) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const div = unit === "head" ? herd.head : unit === "cwt" ? cwt : 1;
    const suffix = unit === "head" ? "/head" : unit === "cwt" ? "/cwt" : "";
    const fmt = v => unit === "total" ? money(v / div) : cwtPrice(v / div);
    return {
      v: total => fmt(total) + suffix,
      s: total => (total > 0 ? "+" : "") + fmt(total) + suffix,
      raw: total => total / div,
      name: unit === "head" ? "$ per head" : unit === "cwt" ? "$ per cwt" : "total $",
      short: unit === "head" ? "per head" : unit === "cwt" ? "per cwt" : "total",
      axis: x => {
        if (unit !== "total") return (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(Math.abs(x) < 10 ? 2 : 0);
        return Math.abs(x) >= 1000 ? (x < 0 ? "-$" : "$") + +(Math.abs(x) / 1000).toFixed(1) + "k" : money(x);
      },
    };
  }

  // --- Main render ---------------------------------------------------------
  function render() {
    const herd = readHerd();
    const code = SimHedge.typeCode(herd.cattleClass, herd.weight);
    const type = DATA.types[code];
    const options = SimHedge.currentOptions(DATA, code);
    const best = SimHedge.matchEndorsement(options, herd.saleDate);
    if (!best) return;
    const match = (selectedWeeks && SimHedge.matchWeeks(options, selectedWeeks, herd.saleDate)) || best;

    const rec = SimHedge.recommend(match.levels, herd, tolerance());
    let plan = rec.plan;
    if (selectedLevel != null) {
      plan = match.levels.find(p => Math.abs(p.level - selectedLevel) < 1e-6) || closestLevel(match.levels, selectedLevel);
    }
    if (!plan) plan = closestLevel(match.levels, 0.95);

    lastPlan = plan; lastMatch = match;
    syncUnitButtons();
    renderLotBanner(plan);
    renderProfile(herd, type);
    renderMarket(herd, options, best, match, plan);
    renderRecommendation(herd, match, rec, plan);
    renderTradeoff(herd, match, plan);
    renderSimulator(herd, match, plan);
    renderBreakdown(herd, match, rec, plan);
  }

  function closestLevel(levels, level) {
    return levels.reduce((b, p) => Math.abs(p.level - level) < Math.abs(b.level - level) ? p : b);
  }

  // --- Lot from the inventory page ------------------------------------------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderLotBanner(plan, message) {
    const banner = $("lot-banner");
    if (!activeLot) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.innerHTML = `
      <p><strong>Finding coverage for your lot "${esc(activeLot.name)}".</strong>
      Its details are filled in below. Pick a plan, then record it once you've bought it from an LRP agent.</p>
      <div class="form-actions">
        <button type="button" class="btn" id="record-plan">I bought the ${pct(plan.level)} plan: record it on this lot</button>
        <a class="btn btn-quiet" href="inventory.html">Back to inventory</a>
      </div>
      ${message ? `<p class="saved">${message}</p>` : ""}
      <p class="fine">Sim Hedge doesn't sell insurance. Recording a plan here only updates your inventory.</p>`;
    $("record-plan").addEventListener("click", recordPlan);
  }

  function recordPlan() {
    const herd = readHerd();
    const lot = Lots.find(activeLot.id) || activeLot;
    Object.assign(lot, {
      cattleClass: herd.cattleClass, head: herd.head, weight: herd.weight,
      saleDate: herd.saleDate, breakeven: herd.breakeven,
      coverage: {
        level: lastPlan.level, coverage: lastPlan.coverage, premium: lastPlan.premium,
        cost: lastPlan.cost, endDate: lastMatch.endDate, weeks: lastMatch.weeks,
        effectiveDate: DATA.current.effectiveDate,
      },
    });
    activeLot = lot;
    const ok = Lots.upsert(lot);
    renderLotBanner(lastPlan, ok
      ? `✓ Recorded the ${pct(lastPlan.level)} plan on "${esc(lot.name)}". <a href="inventory.html">See your inventory →</a>`
      : "This browser isn't letting Sim Hedge save (private window or strict privacy settings).");
  }

  // --- Save the herd as a lot (it shows up on the Inventory page) ----------
  function syncLotSave() {
    $("lot-save-btn").textContent = activeLot ? "Save changes to lot" : "Add lot";
  }

  function lotMessage(html, warn) {
    const msg = $("lot-save-msg");
    msg.hidden = false;
    msg.classList.toggle("warn", !!warn);
    msg.innerHTML = html;
  }

  function saveLot() {
    const name = $("lot-name").value.trim();
    if (!name) { lotMessage("Give the lot a name first.", true); $("lot-name").focus(); return; }
    const herd = readHerd();
    const old = activeLot ? Lots.find(activeLot.id) : null;
    const lot = {
      id: old ? old.id : Lots.newId(), name,
      cattleClass: herd.cattleClass, head: herd.head, weight: herd.weight,
      saleDate: herd.saleDate, breakeven: herd.breakeven, keep: false, coverage: null,
    };
    lot.coverage = Lots.fittingCoverage(old, lot);
    if (!Lots.upsert(lot)) {
      lotMessage("This browser isn't letting Sim Hedge save (private window or strict privacy settings).", true);
      return;
    }
    activeLot = lot;
    history.replaceState(null, "", "lrp.html?lot=" + encodeURIComponent(lot.id));
    syncLotSave();
    renderLotBanner(lastPlan);
    lotMessage(`✓ ${old ? "Saved changes to" : "Added"} "${esc(name)}"${old ? "" : " to your inventory"}. ` +
      `<a href="inventory.html">See your inventory →</a>`);
  }

  // Fills the form from the Breakeven page (lrp.html?from=breakeven).
  function loadBreakevenHandoff() {
    if (new URLSearchParams(location.search).get("from") !== "breakeven") return;
    let r = null;
    try { r = (JSON.parse(localStorage.getItem("simhedge.breakeven.v1") || "null") || {}).result; } catch { r = null; }
    if (!r || !(r.perCwt > 0)) return;
    $("cattle-class").value = r.cattleClass;
    $("head").value = r.head;
    $("weight").value = r.weight;
    if (r.saleDate) $("sale-date").value = r.saleDate;
    $("breakeven").value = r.perCwt;
    $("breakeven-help").innerHTML = `From your <a href="breakeven.html">Breakeven page</a> (all-in costs).`;
  }

  // Fills the form from a lot when the page is opened as lrp.html?lot=...
  function loadLotFromUrl() {
    const id = new URLSearchParams(location.search).get("lot");
    const lot = id ? Lots.find(id) : null;
    if (!lot || lot.keep) return;
    activeLot = lot;
    $("cattle-class").value = lot.cattleClass;
    $("head").value = lot.head;
    $("weight").value = lot.weight;
    $("sale-date").value = lot.saleDate;
    $("breakeven").value = lot.breakeven;
    $("lot-name").value = lot.name;
    if (lot.coverage) { selectedLevel = lot.coverage.level; selectedWeeks = lot.coverage.weeks; }
  }

  // --- 1. Profile ----------------------------------------------------------
  function renderProfile(herd, type) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    let text = `${herd.head.toLocaleString()} head × ${herd.weight.toLocaleString()} lbs = ` +
      `${(cwt * 100).toLocaleString()} lbs (${cwt.toLocaleString()} cwt). USDA calls this type "${type.name}".`;
    const note = $("profile-note");
    note.classList.remove("warn");
    const range = SimHedge.weightRange(herd.cattleClass);
    if (herd.rawWeight > range.max || herd.rawWeight < range.min) {
      const fat = SimHedge.isFat(herd.cattleClass);
      text = herd.rawWeight > range.max
        ? (fat ? `LRP Fed Cattle covers fat cattle up to ${range.max.toLocaleString()} lbs. Showing ${range.max.toLocaleString()} lbs.`
               : "Over 1,000 lbs, these are fat cattle, a different LRP product with different prices. Pick \"Fat cattle\" above. Showing 1,000 lbs.")
        : (fat ? "Under 1,000 lbs, these are feeder cattle, a different LRP product with different prices. Pick feeder steers or heifers above. Showing 1,000 lbs."
               : `LRP Feeder Cattle starts at ${range.min} lbs. Showing ${range.min} lbs.`);
      note.classList.add("warn");
    }
    note.textContent = text;
  }

  // --- 2. Market -----------------------------------------------------------
  function renderMarket(herd, options, best, match, plan) {
    const u = per(herd);
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const exp = match.levels[0].expEnd;
    $("market-summary").innerHTML = [
      stat("Market's expected price at your sale", cwtPrice(exp) + " /cwt", `≈ ${money(exp * herd.weight / 100)} per head`),
      stat("Your herd at that price", u.v(exp * cwt), `at today's expected price (${u.short})`),
      stat("LRP coverage ends", longDate(match.endDate), `${match.weeks}-week plan`),
    ].join("");

    const index = SimHedge.indexName(herd.cattleClass);
    $("index-callout").innerHTML =
      `<strong>LRP pays on one price: the ${index} on your plan's end date.</strong> ` +
      `Not your sale barn price, and not what your buyer pays. If the index ends below your locked-in price, ` +
      `LRP pays the difference, even if you sold for more. If it ends above, LRP pays nothing, even if your local price was lower.`;

    renderLengths(herd, options, best, match);

    // Timing between the plan's end date and the sale date
    const gap = match.gapDays;
    const note = $("match-note");
    const tooEarly = SimHedge.soldTooEarly(match.endDate, herd.saleDate);
    note.classList.toggle("warn", tooEarly || Math.abs(gap) > 21);
    if (tooEarly) {
      note.innerHTML = `<strong>Warning:</strong> you plan to sell ${-gap} days before this plan ends. ` +
        `If you sell more than 60 days early, LRP won't pay. Pick a shorter plan, wait to sell, or skip LRP for this sale.`;
    } else {
      note.textContent = gap === 0
        ? "This plan ends on your sale date."
        : `This plan ends ${Math.abs(gap)} days ${gap > 0 ? "before" : "after"} your sale date.` +
          (Math.abs(gap) > 21 ? " That's a big gap: prices can move between the two dates, so the protection won't line up well with your sale." : "");
    }

    $("cost-col").textContent = `Your cost (${u.short})`;
    $("levels-table").querySelector("tbody").innerHTML = match.levels.map(p => {
      const floor = SimHedge.floorPrice(p, herd.basis);
      const safe = floor >= herd.breakeven;
      const isSel = p === plan;
      const over = herd.budgetPerHead && SimHedge.costPerHead(p, herd.weight) > herd.budgetPerHead;
      return `<tr data-level="${p.level}" class="${isSel ? "selected" : ""}${over ? " over-budget" : ""}" tabindex="0">
        <td>${pct(p.level)}${isSel ? " · selected" : ""}${over ? ' <span class="badge">Over budget</span>' : ""}</td>
        <td>${cwtPrice(p.coverage)}</td>
        <td>${cwtPrice(floor)}</td>
        <td>${u.v(p.premium * cwt)}</td>
        <td>${subsidyPct(p)}</td>
        <td class="${safe ? "yes" : "no"}">${safe ? "✓ Yes" : "✗ No"}</td>
      </tr>`;
    }).join("");

    const herdLbs = herd.head * herd.weight;
    const fut = SimHedge.futuresContract(herd.cattleClass);
    const share = herdLbs / fut.lbs;
    $("futures-note").textContent =
      `Why not futures? One ${fut.name} contract is ${fut.lbs.toLocaleString()} lbs. Your herd is ${herdLbs.toLocaleString()} lbs, ` +
      `${share < 1 ? "only " : ""}${Math.round(share * 100)}% of ${share < 1 ? "one contract" : "a contract"}, so futures can't match it cleanly ` +
      `(and brokers usually want a margin account). LRP covers any number of head.`;

    $("data-source").innerHTML =
      `Prices and premiums: USDA Risk Management Agency, LRP ${SimHedge.isFat(herd.cattleClass) ? "Fed" : "Feeder"} Cattle, ${DATA.state}, effective ` +
      `${longDate(DATA.current.effectiveDate)}. The expected price is USDA's expected ending value, based on ${fut.name} futures` +
      `${SimHedge.isFat(herd.cattleClass) ? "" : " and adjusted for your cattle type and weight"}. ` +
      `Source: <a href="${DATA.source}" target="_blank" rel="noopener">USDA RMA daily data files</a>. Updated ${longDate(DATA.fetchedOn)}.`;
  }

  // Plan lengths on sale today. Each one is a button, marked by where the
  // sale date falls against that plan's 60-day ownership window.
  const WINDOW_MARK = { window: ["ok", "✓"], close: ["ok", "✓"], early: ["early", "✗"], after: ["after", "◷"] };
  // A plan that ends a few days before the sale is fine: the farmer owns the
  // cattle through the end date. Only a gap of more than 3 weeks is flagged.
  function windowFor(endDate, saleDate) {
    const w = SimHedge.saleWindow(endDate, saleDate);
    if (w.status === "after" && w.daysAfter <= 21) w.status = "close";
    return w;
  }

  function renderLengths(herd, options, best, match) {
    const lengths = SimHedge.availableLengths(options);
    $("length-row").innerHTML = lengths.map(l => {
      const w = windowFor(l.endDate, herd.saleDate);
      const [cls, icon] = WINDOW_MARK[w.status];
      const tip = w.status === "window" ? `Ends ${longDate(l.endDate)}. Your sale is in the 60-day window.`
        : w.status === "close" ? `Ends ${longDate(l.endDate)}, ${w.daysAfter} days before your sale. You own the cattle through the end, so coverage holds.`
        : w.status === "early" ? `Ends ${longDate(l.endDate)}. Your sale is too early: the window opens ${longDate(w.opens)}.`
        : `Ends ${longDate(l.endDate)}, ${w.daysAfter} days before your sale.`;
      return `<button type="button" class="len ${cls}${l.weeks === match.weeks ? " on" : ""}" data-weeks="${l.weeks}"
        aria-pressed="${l.weeks === match.weeks}" title="${tip}">${l.weeks}<i>${icon}</i></button>`;
    }).join("") + `<span class="len-unit">weeks</span>`;

    const min = lengths[0].weeks, max = lengths[lengths.length - 1].weeks;
    const w = windowFor(match.endDate, herd.saleDate);
    const windowText = w.status === "window"
      ? `Your sale date (${shortDate(herd.saleDate)}) is inside this plan's window: ${shortDate(w.opens)} to ${shortDate(match.endDate)}.`
      : w.status === "close"
        ? `This plan ends ${shortDate(match.endDate)}, ${w.daysAfter} day${w.daysAfter === 1 ? "" : "s"} before your sale. You'll own the cattle through the end date, so coverage holds.`
      : w.status === "early"
        ? `Your sale date (${shortDate(herd.saleDate)}) is before this plan's window opens (${shortDate(w.opens)}), so LRP won't pay.`
        : `This plan ends ${shortDate(match.endDate)}, ${w.daysAfter} days before your sale, so the last stretch isn't covered.`;
    $("length-explain").innerHTML =
      `LRP is only offered in ${min}–${max} week plans. The <strong>${best.weeks}-week plan</strong> lines up best with your sale date. ` +
      (match.weeks !== best.weeks ? `You're looking at the <strong>${match.weeks}-week plan</strong>. ` : "") +
      `You must still own the cattle within 60 days of the end date.<br><span class="window-line ${WINDOW_MARK[w.status][0]}">${windowText}</span>`;

    $("length-why").innerHTML = `
      <ul>
        <li>Each length ends on a set date. USDA posts new prices and end dates every business day.</li>
        <li>Pick the one that ends closest to when you sell. If it ends well before the sale, the last weeks aren't protected.
          If it ends after, LRP pays on the index on the end date, after you've already sold.</li>
        <li>You can sell during the last 60 days of coverage. Sell earlier than that and the coverage ends with no payout,
          and you still owe the premium.</li>
      </ul>
      <p class="fine">Plans on sale today:</p>
      <div class="len-list">${lengths.map(l =>
        `<span${l.weeks === match.weeks ? ' class="on"' : ""}>${l.weeks} weeks: ends ${longDate(l.endDate)}</span>`).join("")}</div>`;
  }

  function stat(label, value, sub, color) {
    const sw = color ? `<span class="swatch" style="background:${color}"></span>` : "";
    return `<div class="stat"><div class="label">${sw}${label}</div><div class="value">${value}</div><div class="sub">${sub || ""}</div></div>`;
  }

  // --- 3. Recommendation ---------------------------------------------------
  function renderRecommendation(herd, match, rec, plan) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const floor = SimHedge.floorPrice(plan, herd.basis);
    const box = $("recommendation");
    const picked = selectedLevel != null && plan !== rec.plan;
    const perHead = SimHedge.costPerHead(plan, herd.weight);
    let title;
    if (picked) title = `You're trying the ${pct(plan.level)} plan.`;
    else if (rec.reason === "cheapest-safe") title = `Best fit: the ${pct(plan.level)} plan.`;
    else if (rec.reason === "max") title = `Most protection${herd.budgetPerHead ? " within your budget" : ""}: the ${pct(plan.level)} plan.`;
    else if (rec.reason === "none-safe") title = `No plan available today protects your breakeven. Closest: ${pct(plan.level)}.`;
    else if (rec.reason === "none-safe-budget") title = `No plan within your budget protects your breakeven. Best you can afford: ${pct(plan.level)}.`;
    else if (rec.reason === "over-budget") title = `Every plan costs more than ${money(herd.budgetPerHead)} per head. The cheapest is ${pct(plan.level)} at ${cwtPrice(perHead)} per head.`;
    else title = `Comparing every level. Showing the ${pct(plan.level)} plan below; click any row or dot to switch.`;

    box.innerHTML = `<p><strong>${title}</strong></p>
      <p>Locks in ${cwtPrice(plan.coverage)}/cwt until ${longDate(match.endDate)}. Worst case after its cost:
      <strong>${cwtPrice(floor)}/cwt</strong> vs. your ${cwtPrice(herd.breakeven)} breakeven.
      Cost: <strong>${money(plan.premium * cwt)}</strong> (${cwtPrice(perHead)} per head).</p>` +
      (SimHedge.soldTooEarly(match.endDate, herd.saleDate)
        ? `<p class="warn-line">⚠ Your sale date is more than 60 days before this plan ends, so LRP won't pay if you sell then.</p>`
        : "");
  }

  // Protection vs. cost: one dot per coverage level.
  function renderTradeoff(herd, match, plan) {
    const u = per(herd);
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const budgetTotal = herd.budgetPerHead ? herd.budgetPerHead * herd.head : null;
    Charts.scatter($("tradeoff-chart"), {
      color: Charts.cssVar("--series-lrp"),
      points: match.levels.map(p => {
        const floor = SimHedge.floorPrice(p, herd.basis);
        return {
          id: p.level, x: u.raw(p.premium * cwt), y: floor, label: pct(p.level), selected: p === plan,
          tip: `<div class="t-head">${pct(p.level)} coverage</div>
            <div class="t-row"><span>Your cost</span><b>${u.v(p.premium * cwt)}</b></div>
            <div class="t-row"><span>Worst-case price</span><b>${cwtPrice(floor)}/cwt</b></div>
            <div class="t-row"><span>Covers breakeven?</span><b>${floor >= herd.breakeven ? "Yes" : "No"}</b></div>`,
        };
      }),
      hLine: { y: herd.breakeven, label: `Your breakeven ${cwtPrice(herd.breakeven)}` },
      vLine: budgetTotal ? { x: u.raw(budgetTotal), label: "Your budget" } : null,
      xFormat: u.axis,
      yFormat: v => "$" + Math.round(v),
      xTitle: `Your cost (${u.name})`,
      yTitle: "Worst-case price ($/cwt)",
      onPick: level => { selectedLevel = level; render(); },
    });
  }

  // --- 4. Simulator --------------------------------------------------------
  function renderSimulator(herd, match, plan) {
    const u = per(herd);
    const move = Number($("move").value) / 100;
    const exp = match.levels[0].expEnd;
    const price = exp * (1 + move);
    $("move-label").textContent =
      `${move > 0 ? "+" : ""}${Math.round(move * 100)}% → ${cwtPrice(price)}/cwt` + (move === 0 ? " (no change)" : "");

    // Coverage level picker (lowest to highest)
    const asc = match.levels.slice().sort((a, b) => a.level - b.level);
    $("level-chips").innerHTML = asc.map(p =>
      `<button type="button" class="len${p === plan ? " on" : ""}" data-level="${p.level}" aria-pressed="${p === plan}">${pct(p.level)}</button>`).join("");
    const i = asc.indexOf(plan);
    $("level-prev").disabled = i <= 0;
    $("level-next").disabled = i >= asc.length - 1;

    const none = SimHedge.outcome(herd, price, null);
    const withPlan = SimHedge.outcome(herd, price, plan);
    const lrpColor = Charts.cssVar("--series-lrp"), noneColor = Charts.cssVar("--series-none");

    $("sim-tiles").innerHTML = [
      stat("No coverage", u.s(none.profit), "profit vs. breakeven", noneColor),
      stat(`With ${pct(plan.level)} LRP`, u.s(withPlan.profit), "profit vs. breakeven", lrpColor),
      stat("Difference LRP makes", u.s(withPlan.profit - none.profit),
        withPlan.payout > 0 ? `payout ${u.v(withPlan.payout)} − cost ${u.v(withPlan.premium)}` : `no payout; cost ${u.v(withPlan.premium)}`),
    ].join("");

    const xs = [];
    for (let m = -30; m <= 20; m++) xs.push(m);
    const series = [
      { name: "No coverage", color: noneColor, values: xs.map(m => ({ x: m, y: u.raw(SimHedge.outcome(herd, exp * (1 + m / 100), null).profit) })) },
      { name: `With ${pct(plan.level)} LRP`, color: lrpColor, values: xs.map(m => ({ x: m, y: u.raw(SimHedge.outcome(herd, exp * (1 + m / 100), plan).profit) })) },
    ];
    $("sim-legend").innerHTML = series.map(s => `<span style="--c:${s.color}">${s.name}</span>`).join("") +
      `<span style="--c:var(--ink-3)">Breakeven ($0 line)</span>`;
    Charts.line($("sim-chart"), {
      series,
      marker: Math.round(move * 100),
      xFormat: v => (v > 0 ? "+" : "") + v + "%",
      yFormat: (v, inTip) => inTip ? (v > 0 ? "+" : "") + u.axis(v) : u.axis(v),
      tipTitle: x => `Prices ${x > 0 ? "+" : ""}${x}% → ${cwtPrice(exp * (1 + x / 100))}/cwt`,
      xTitle: "Change in cattle price by your sale date",
      yTitle: `Profit or loss vs. breakeven (${u.name})`,
    });

    $("scenario-caption").textContent =
      `Every plan if prices end ${move > 0 ? "up" : move < 0 ? "down" : "flat"} ${Math.abs(Math.round(move * 100))}% ` +
      `(${cwtPrice(price)}/cwt), shown ${u.short}. Click a row to try that plan.`;
    const rows = [{ label: "No coverage", r: none }].concat(match.levels.map(p => ({ label: `LRP ${pct(p.level)}`, r: SimHedge.outcome(herd, price, p), p })));
    $("scenario-table").querySelector("tbody").innerHTML = rows.map(({ label, r, p }) => `
      <tr class="${p === plan ? "selected" : ""}"${p ? ` data-level="${p.level}" tabindex="0"` : ""}>
        <td>${label}</td><td>${u.v(r.saleRevenue)}</td><td>${u.v(r.payout)}</td><td>${u.v(r.premium)}</td>
        <td class="${r.profit >= 0 ? "yes" : "no"}">${u.s(r.profit)}</td>
        <td>${p ? u.s(r.profit - none.profit) : "–"}</td>
      </tr>`).join("");
  }

  // --- Breakdown ------------------------------------------------------------
  // Built only from the numbers above. No forecasts. Always in whole-herd dollars.
  function renderBreakdown(herd, match, rec, plan) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const exp = match.levels[0].expEnd;
    const floor = SimHedge.floorPrice(plan, herd.basis);
    const cost = plan.premium * cwt;
    const p = [];

    p.push(`Your ${herd.head} ${herd.cattleClass} at ${herd.weight} lbs add up to ${cwt.toLocaleString()} cwt. ` +
      `Today the futures market expects these cattle to be worth about ${cwtPrice(exp)}/cwt around ${longDate(match.endDate)}, ` +
      `which is ${exp >= herd.breakeven ? "above" : "below"} your ${cwtPrice(herd.breakeven)} breakeven.`);

    const safe = match.levels.filter(l => SimHedge.floorPrice(l, herd.basis) >= herd.breakeven);
    const userPicked = selectedLevel != null && plan !== rec.plan;

    if ((rec.reason === "none-safe" || rec.reason === "none-safe-budget") && !userPicked) {
      p.push(`No LRP plan ${rec.reason === "none-safe-budget" ? "within your budget" : "on sale today"} can guarantee your breakeven. ` +
        `The best worst-case price is ${cwtPrice(floor)}/cwt, ${cwtPrice(herd.breakeven - floor)} short. ` +
        `LRP can still limit how much you lose in a price drop, but it can't promise a profit at these prices.`);
    } else if (rec.reason === "over-budget" && !userPicked) {
      p.push(`Your budget is ${money(herd.budgetPerHead)} per head, and the cheapest plan costs ${cwtPrice(SimHedge.costPerHead(plan, herd.weight))} per head. ` +
        `Raising the budget or choosing a different plan length may help.`);
    } else if (rec.reason === "max" && !userPicked) {
      const cheapest = safe.length ? safe.reduce((a, b) => a.premium < b.premium ? a : b) : null;
      p.push(`The ${pct(plan.level)} plan locks in the highest price ${herd.budgetPerHead ? "within your budget" : "available"}, ${cwtPrice(plan.coverage)}/cwt, for ${money(cost)}.` +
        (cheapest && cheapest !== plan && cheapest.premium < plan.premium
          ? ` That's ${money(cost - cheapest.premium * cwt)} more than the cheapest plan that still covers your breakeven (${pct(cheapest.level)} at ${money(cheapest.premium * cwt)}). The extra buys ${cwtPrice(plan.coverage - cheapest.coverage)}/cwt of additional price floor.`
          : ""));
    } else if (rec.reason === "compare" && !userPicked) {
      const costs = match.levels.map(l => l.premium * cwt);
      p.push(`Plans range from ${money(Math.min(...costs))} to ${money(Math.max(...costs))} for your herd. ` +
        `${safe.length} of ${match.levels.length} coverage levels keep your worst case at or above breakeven.`);
    } else {
      const cheaper = match.levels.filter(l => l.premium < plan.premium).sort((a, b) => b.premium - a.premium)[0];
      p.push(`The ${pct(plan.level)} plan locks in ${cwtPrice(plan.coverage)}/cwt. After its ${cwtPrice(plan.premium)}/cwt cost, ` +
        `the lowest you'd end up with is ${cwtPrice(floor)}/cwt, ${floor >= herd.breakeven ? cwtPrice(floor - herd.breakeven) + " above" : cwtPrice(herd.breakeven - floor) + " below"} breakeven. ` +
        `It costs ${money(cost)} total, and USDA pays ${subsidyPct(plan)} of the full premium.` +
        (cheaper && rec.reason === "cheapest-safe" && !userPicked
          ? ` The next cheaper plan (${pct(cheaper.level)}) would leave a worst case of ${cwtPrice(SimHedge.floorPrice(cheaper, herd.basis))}, below breakeven, which is why it isn't the pick.`
          : ""));
    }

    const down = SimHedge.outcome(herd, exp * 0.85, plan), downNone = SimHedge.outcome(herd, exp * 0.85, null);
    const up = SimHedge.outcome(herd, exp * 1.10, plan), upNone = SimHedge.outcome(herd, exp * 1.10, null);
    p.push(`For scale: if prices fell 15%, doing nothing would leave you ${signed(downNone.profit)} vs. breakeven and this plan ${signed(down.profit)}. ` +
      `If prices rose 10%, the plan pays nothing and you'd give up its ${money(up.premium)} cost (${signed(upNone.profit)} without it vs. ${signed(up.profit)} with it). ` +
      `That cost is the price of the protection.`);

    $("breakdown-text").innerHTML = p.map(t => `<p>${t}</p>`).join("");
  }

  // --- Wiring --------------------------------------------------------------
  function syncUnitButtons() {
    document.querySelectorAll(".unit-toggle [data-unit]").forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.unit === unit)));
  }

  function stepLevel(dir) {
    const asc = lastMatch.levels.slice().sort((a, b) => a.level - b.level);
    const i = asc.indexOf(lastPlan) + dir;
    if (i >= 0 && i < asc.length) { selectedLevel = asc[i].level; render(); }
  }

  function init() {
    if (!DATA) {
      document.querySelector("main").innerHTML = `<section class="card"><h2>Data missing</h2><p>Run <code>python3 site/tools/fetch_lrp.py</code> to download USDA LRP data.</p></section>`;
      return;
    }
    // Default sale date: about 5 months after the data date.
    const d = new Date(DATA.current.effectiveDate + "T12:00:00");
    d.setDate(d.getDate() + 150);
    $("sale-date").value = d.toISOString().slice(0, 10);
    loadLotFromUrl();

    // Feeder and fat cattle have different weight ranges.
    const syncWeightRange = () => {
      const cls = $("cattle-class").value, r = SimHedge.weightRange(cls), w = $("weight");
      w.min = r.min; w.max = r.max;
      $("weight-hint").textContent = SimHedge.isFat(cls) ? "Fat cattle: 1,000–1,800 lbs." : "Feeder cattle: 100–1,000 lbs.";
      const v = Number(w.value);
      if (!(v >= r.min && v <= r.max)) w.value = SimHedge.isFat(cls) ? 1350 : 750;
    };
    $("cattle-class").addEventListener("change", syncWeightRange);
    syncWeightRange();

    // Example breakevens differ a lot between feeder and fat cattle.
    const EXAMPLE_BE = { feeder: 300, fat: 225 };
    $("cattle-class").addEventListener("change", () => {
      const be = $("breakeven"), fat = SimHedge.isFat($("cattle-class").value);
      if (Number(be.value) === EXAMPLE_BE[fat ? "feeder" : "fat"]) {
        be.value = EXAMPLE_BE[fat ? "fat" : "feeder"];
      }
    });

    // Coming from the Breakeven page ("Use this breakeven in the LRP tool")
    loadBreakevenHandoff();

    // Add lot / Save changes to lot
    syncLotSave();
    $("lot-save-btn").addEventListener("click", saveLot);
    $("lot-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveLot(); } });

    // A new herd or priority resets the picks back to the recommendation.
    $("herd-form").addEventListener("input", () => { selectedLevel = null; selectedWeeks = null; render(); });
    $("herd-form").addEventListener("submit", e => e.preventDefault());
    document.querySelectorAll("input[name=tolerance]").forEach(r =>
      r.addEventListener("change", () => { selectedLevel = null; render(); }));
    $("budget").addEventListener("input", () => { selectedLevel = null; render(); });
    $("move").addEventListener("input", render);

    // Picking a plan: table rows (sections 2 and 4) and level chips
    const pickRow = e => {
      const el = e.target.closest("[data-level]");
      if (!el) return;
      selectedLevel = Number(el.dataset.level);
      render();
    };
    for (const id of ["levels-table", "scenario-table", "level-chips"]) {
      $(id).addEventListener("click", pickRow);
      $(id).addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickRow(e); } });
    }
    $("level-prev").addEventListener("click", () => stepLevel(-1));
    $("level-next").addEventListener("click", () => stepLevel(1));

    // Picking a plan length
    $("length-row").addEventListener("click", e => {
      const b = e.target.closest("[data-weeks]");
      if (!b) return;
      selectedWeeks = Number(b.dataset.weeks);
      render();
    });

    // Total / per head / per cwt
    document.querySelectorAll(".unit-toggle").forEach(g => g.addEventListener("click", e => {
      const b = e.target.closest("[data-unit]");
      if (!b) return;
      unit = b.dataset.unit;
      render();
    }));

    // Redraw charts in the right colors if the device switches light/dark mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    render();
  }
  init();
})();
