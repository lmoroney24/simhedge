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
  const monthYear = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });

  // --- State ---------------------------------------------------------------
  let selectedLevel = null;   // coverage level picked by clicking the table; null = use recommendation

  function readHerd() {
    return {
      cattleClass: $("cattle-class").value,
      head: Math.max(1, Number($("head").value) || 1),
      weight: Math.min(1000, Math.max(100, Number($("weight").value) || 100)),
      rawWeight: Number($("weight").value) || 0,
      saleDate: $("sale-date").value,
      breakeven: Number($("breakeven").value) || 0,
      basis: Number($("basis").value) || 0,
    };
  }
  const tolerance = () => document.querySelector("input[name=tolerance]:checked").value;

  // --- Main render ---------------------------------------------------------
  function render() {
    const herd = readHerd();
    const code = SimHedge.typeCode(herd.cattleClass, herd.weight);
    const type = DATA.types[code];
    const options = SimHedge.currentOptions(DATA, code);
    const match = SimHedge.matchEndorsement(options, herd.saleDate);
    if (!match) return;

    const rec = SimHedge.recommend(match.levels, herd, tolerance());
    let plan = rec.plan;
    if (selectedLevel != null) {
      plan = match.levels.find(p => Math.abs(p.level - selectedLevel) < 1e-6) || plan;
    }
    if (!plan) plan = closestLevel(match.levels, 0.95);

    renderProfile(herd, type);
    renderMarket(herd, type, match, plan);
    renderRecommendation(herd, match, rec, plan);
    renderSimulator(herd, match, plan);
    renderBreakdown(herd, match, rec, plan);
    renderHistory(herd, type, match, plan);
  }

  function closestLevel(levels, level) {
    return levels.reduce((best, p) => Math.abs(p.level - level) < Math.abs(best.level - level) ? p : best);
  }

  // --- 1. Profile ----------------------------------------------------------
  function renderProfile(herd, type) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    let text = `${herd.head.toLocaleString()} head × ${herd.weight.toLocaleString()} lbs = ` +
      `${(cwt * 100).toLocaleString()} lbs (${cwt.toLocaleString()} cwt). USDA calls this type "${type.name}".`;
    const note = $("profile-note");
    note.classList.remove("warn");
    if (herd.rawWeight > 1000) {
      text = "LRP Feeder Cattle covers cattle up to 1,000 lbs. Heavier cattle fall under Fed Cattle LRP, which Sim Hedge doesn't cover yet. Showing 1,000 lbs.";
      note.classList.add("warn");
    }
    note.textContent = text;
  }

  // --- 2. Market -----------------------------------------------------------
  function renderMarket(herd, type, match, plan) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const exp = match.levels[0].expEnd;
    $("market-summary").innerHTML = [
      stat("Market's expected price at your sale", cwtPrice(exp) + " /cwt", `≈ ${money(exp * herd.weight / 100)} per head`),
      stat("Your herd at that price", money(exp * cwt), `before your ${cwtPrice(herd.basis)} basis`),
      stat("LRP coverage ends", longDate(match.endDate), `${match.weeks}-week plan`),
    ].join("");

    const gap = match.gapDays;
    const note = $("match-note");
    note.classList.toggle("warn", Math.abs(gap) > 21);
    note.textContent = gap === 0
      ? "This plan ends on your sale date."
      : `Closest plan available ends ${Math.abs(gap)} days ${gap > 0 ? "before" : "after"} your sale date.` +
        (Math.abs(gap) > 21 ? " That's a big gap: prices can move between the two dates, so the protection won't line up well with your sale." : "");

    const rows = match.levels.map(p => {
      const floor = SimHedge.floorPrice(p, herd.basis);
      const safe = floor >= herd.breakeven;
      const isSel = p === plan;
      return `<tr data-level="${p.level}" class="${isSel ? "selected" : ""}" tabindex="0">
        <td>${pct(p.level)}${isSel ? " · selected" : ""}</td>
        <td>${cwtPrice(p.coverage)}</td>
        <td>${cwtPrice(floor)}</td>
        <td>${money(p.premium * herd.weight / 100)}</td>
        <td>${money(p.premium * cwt)}</td>
        <td>${subsidyPct(p)}</td>
        <td class="${safe ? "yes" : "no"}">${safe ? "✓ Yes" : "✗ No"}</td>
      </tr>`;
    }).join("");
    $("levels-table").querySelector("tbody").innerHTML = rows;

    const herdLbs = herd.head * herd.weight;
    const share = herdLbs / SimHedge.FUTURES_CONTRACT_LBS;
    $("futures-note").textContent =
      `Why not futures? One CME Feeder Cattle contract is 50,000 lbs. Your herd is ${herdLbs.toLocaleString()} lbs, ` +
      `${share < 1 ? "only " : ""}${Math.round(share * 100)}% of one contract, so futures can't match it cleanly ` +
      `(and brokers usually want a margin account). LRP covers any number of head.`;

    $("data-source").innerHTML =
      `Prices and premiums: USDA Risk Management Agency, LRP Feeder Cattle, ${DATA.state}, effective ` +
      `${longDate(DATA.current.effectiveDate)}. The expected price is USDA's expected ending value, based on CME Feeder Cattle futures and adjusted for your cattle type and weight. ` +
      `Source: <a href="${DATA.source}" target="_blank" rel="noopener">public.rma.usda.gov</a>. Downloaded ${longDate(DATA.fetchedOn)}.`;
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
    let title;
    if (picked) title = `You're trying the ${pct(plan.level)} plan.`;
    else if (rec.reason === "cheapest-safe") title = `Best fit: the ${pct(plan.level)} plan.`;
    else if (rec.reason === "max") title = `Most protection: the ${pct(plan.level)} plan.`;
    else if (rec.reason === "none-safe") title = `No plan available today protects your breakeven. Closest: ${pct(plan.level)}.`;
    else title = `Comparing every level. Showing the ${pct(plan.level)} plan below; click any row to switch.`;

    box.innerHTML = `<p><strong>${title}</strong></p>
      <p>Locks in ${cwtPrice(plan.coverage)}/cwt until ${longDate(match.endDate)}. Worst case after cost and basis:
      <strong>${cwtPrice(floor)}/cwt</strong> vs. your ${cwtPrice(herd.breakeven)} breakeven.
      Cost: <strong>${money(plan.premium * cwt)}</strong> (${money(plan.premium * herd.weight / 100)} per head).</p>`;
  }

  // --- 4. Simulator --------------------------------------------------------
  function renderSimulator(herd, match, plan) {
    const move = Number($("move").value) / 100;
    const exp = match.levels[0].expEnd;
    const price = exp * (1 + move);
    $("move-label").textContent =
      `${move > 0 ? "+" : ""}${Math.round(move * 100)}% → ${cwtPrice(price)}/cwt` + (move === 0 ? " (no change)" : "");

    const none = SimHedge.outcome(herd, price, null);
    const withPlan = SimHedge.outcome(herd, price, plan);
    const lrpColor = Charts.cssVar("--series-lrp"), noneColor = Charts.cssVar("--series-none");

    $("sim-tiles").innerHTML = [
      stat("No coverage", signed(none.profit), "profit vs. breakeven", noneColor),
      stat(`With ${pct(plan.level)} LRP`, signed(withPlan.profit), "profit vs. breakeven", lrpColor),
      stat("Difference LRP makes", signed(withPlan.profit - none.profit),
        withPlan.payout > 0 ? `payout ${money(withPlan.payout)} − cost ${money(withPlan.premium)}` : `no payout; cost ${money(withPlan.premium)}`),
    ].join("");

    const xs = [];
    for (let m = -30; m <= 20; m++) xs.push(m);
    const series = [
      { name: "No coverage", color: noneColor, values: xs.map(m => ({ x: m, y: SimHedge.outcome(herd, exp * (1 + m / 100), null).profit })) },
      { name: `With ${pct(plan.level)} LRP`, color: lrpColor, values: xs.map(m => ({ x: m, y: SimHedge.outcome(herd, exp * (1 + m / 100), plan).profit })) },
    ];
    $("sim-legend").innerHTML = series.map(s => `<span style="--c:${s.color}">${s.name}</span>`).join("") +
      `<span style="--c:var(--ink-3)">Breakeven ($0 line)</span>`;
    Charts.line($("sim-chart"), {
      series,
      marker: Math.round(move * 100),
      xFormat: v => (v > 0 ? "+" : "") + v + "%",
      yFormat: v => (Math.abs(v) >= 1000 ? (v < 0 ? "-$" : "$") + Math.round(Math.abs(v) / 1000) + "k" : money(v)),
      tipTitle: x => `Prices ${x > 0 ? "+" : ""}${x}% → ${cwtPrice(exp * (1 + x / 100))}/cwt`,
    });

    $("scenario-caption").textContent =
      `Every plan if prices end ${move > 0 ? "up" : move < 0 ? "down" : "flat"} ${Math.abs(Math.round(move * 100))}% (${cwtPrice(price)}/cwt)`;
    const rows = [{ label: "No coverage", r: none }].concat(match.levels.map(p => ({ label: `LRP ${pct(p.level)}`, r: SimHedge.outcome(herd, price, p), p })));
    $("scenario-table").querySelector("tbody").innerHTML = rows.map(({ label, r, p }) => `
      <tr class="${p === plan ? "selected" : ""}">
        <td>${label}</td><td>${money(r.saleRevenue)}</td><td>${money(r.payout)}</td><td>${money(r.premium)}</td>
        <td class="${r.profit >= 0 ? "yes" : "no"}">${signed(r.profit)}</td>
        <td>${p ? signed(r.profit - none.profit) : "–"}</td>
      </tr>`).join("");
  }

  // --- Plain-English breakdown --------------------------------------------
  // Built only from the numbers above. No forecasts.
  function renderBreakdown(herd, match, rec, plan) {
    const cwt = SimHedge.herdCwt(herd.head, herd.weight);
    const exp = match.levels[0].expEnd;
    const floor = SimHedge.floorPrice(plan, herd.basis);
    const cost = plan.premium * cwt;
    const p = [];

    p.push(`Your ${herd.head} ${herd.cattleClass} at ${herd.weight} lbs add up to ${cwt.toLocaleString()} cwt. ` +
      `Today the futures market expects these cattle to be worth about ${cwtPrice(exp)}/cwt around ${longDate(match.endDate)}, ` +
      `which is ${exp + herd.basis >= herd.breakeven ? "above" : "below"} your ${cwtPrice(herd.breakeven)} breakeven once your ${cwtPrice(herd.basis)} basis is included.`);

    const safe = match.levels.filter(l => SimHedge.floorPrice(l, herd.basis) >= herd.breakeven);
    const userPicked = selectedLevel != null && plan !== rec.plan;

    if (rec.reason === "none-safe" && !userPicked) {
      p.push(`No LRP plan on sale today can guarantee your breakeven. The best worst-case price is ${cwtPrice(floor)}/cwt, ` +
        `${cwtPrice(herd.breakeven - floor)} short. LRP can still limit how much you lose in a price drop, but it can't promise a profit at these prices.`);
    } else if (rec.reason === "max" && !userPicked) {
      const cheapest = safe.length ? safe.reduce((a, b) => a.premium < b.premium ? a : b) : null;
      p.push(`The ${pct(plan.level)} plan locks in the highest price available, ${cwtPrice(plan.coverage)}/cwt, for ${money(cost)}.` +
        (cheapest && cheapest !== plan
          ? ` That's ${money(cost - cheapest.premium * cwt)} more than the cheapest plan that still covers your breakeven (${pct(cheapest.level)} at ${money(cheapest.premium * cwt)}). The extra buys ${cwtPrice(plan.coverage - cheapest.coverage)}/cwt of additional price floor.`
          : ""));
    } else if (rec.reason === "compare" && !userPicked) {
      const costs = match.levels.map(l => l.premium * cwt);
      p.push(`Plans range from ${money(Math.min(...costs))} to ${money(Math.max(...costs))} for your herd. ` +
        `${safe.length} of ${match.levels.length} coverage levels keep your worst case at or above breakeven.`);
    } else {
      const cheaper = match.levels.filter(l => l.premium < plan.premium).sort((a, b) => b.premium - a.premium)[0];
      p.push(`The ${pct(plan.level)} plan locks in ${cwtPrice(plan.coverage)}/cwt. After its ${cwtPrice(plan.premium)}/cwt cost and your basis, ` +
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

  // --- 5. History check ----------------------------------------------------
  function renderHistory(herd, type, match, plan) {
    const results = SimHedge.backtest(DATA, herd, match.weeks, plan.level, type.factor);
    $("history-intro").textContent =
      `If you had bought this same plan (${match.weeks} weeks, ${pct(plan.level)} coverage) for ${herd.head} head ` +
      `at ${herd.weight} lbs at the start of each month since ${DATA.history.length ? monthYear(DATA.history[0].effectiveDate) : "2021"}, ` +
      `here's what it actually would have paid, using USDA's real published prices.`;

    if (!results.length) {
      $("history-headline").textContent = "No finished plans of this length and level in the data yet.";
      $("history-tiles").innerHTML = "";
      $("history-chart").innerHTML = "";
      $("history-legend").innerHTML = "";
      $("history-table").querySelector("tbody").innerHTML = "";
      return;
    }

    const paid = results.filter(r => r.payout > 0);
    const won = results.filter(r => r.net > 0);
    const best = results.reduce((a, b) => b.net > a.net ? b : a);
    const worst = results.reduce((a, b) => b.net < a.net ? b : a);
    const avg = results.reduce((s, r) => s + r.net, 0) / results.length;

    $("history-headline").innerHTML = best.net > 0
      ? `Bought in <strong>${monthYear(best.bought)}</strong>, this plan would have paid you <strong>${money(best.payout)}</strong> on a <strong>${money(best.premium)}</strong> cost.`
      : `In every month tested, this plan cost more than it paid. Best case: ${signed(best.net)} (${monthYear(best.bought)}).`;

    $("history-tiles").innerHTML = [
      stat("Paid out", `${paid.length} of ${results.length}`, "purchases had a payout"),
      stat("Paid more than it cost", `${won.length} of ${results.length}`, `${Math.round(won.length / results.length * 100)}% of the time`),
      stat("Average result per purchase", signed(avg), "payout minus cost"),
      stat("Worst case", signed(worst.net), `bought ${monthYear(worst.bought)}: cost, no payout`),
    ].join("");

    $("history-legend").innerHTML =
      `<span class="box" style="--c:var(--pos)">Paid more than it cost</span><span class="box" style="--c:var(--neg)">Cost more than it paid</span>`;
    Charts.bars($("history-chart"), {
      bars: results.map((r, i) => ({
        value: r.net,
        label: r.bought.slice(5, 7) === "01" || i === 0 ? r.bought.slice(0, 4) : "",
        tip: `<div class="t-head">Bought ${monthYear(r.bought)}, ended ${longDate(r.ended)}</div>
          <div class="t-row"><span>Locked-in price</span><b>${cwtPrice(r.coverage)}</b></div>
          <div class="t-row"><span>Actual price</span><b>${cwtPrice(r.actualEnd)}</b></div>
          <div class="t-row"><span>Payout</span><b>${money(r.payout)}</b></div>
          <div class="t-row"><span>Cost</span><b>${money(r.premium)}</b></div>
          <div class="t-row"><span>Net</span><b>${signed(r.net)}</b></div>`,
      })),
      yFormat: v => (Math.abs(v) >= 1000 ? (v < 0 ? "-$" : "$") + Math.round(Math.abs(v) / 1000) + "k" : money(v)),
    });

    $("history-table").querySelector("tbody").innerHTML = results.slice().reverse().map(r => `
      <tr><td>${monthYear(r.bought)}</td><td>${longDate(r.ended)}</td><td>${cwtPrice(r.coverage)}</td><td>${cwtPrice(r.actualEnd)}</td>
      <td>${money(r.payout)}</td><td>${money(r.premium)}</td><td class="${r.net >= 0 ? "yes" : "no"}">${signed(r.net)}</td></tr>`).join("");
  }

  // --- Wiring --------------------------------------------------------------
  function init() {
    if (!DATA) {
      document.querySelector("main").innerHTML = `<section class="card"><h2>Data missing</h2><p>Run <code>python3 tools/fetch_lrp.py</code> to download USDA LRP data.</p></section>`;
      return;
    }
    // Default sale date: about 5 months after the data date.
    const d = new Date(DATA.current.effectiveDate + "T12:00:00");
    d.setDate(d.getDate() + 150);
    $("sale-date").value = d.toISOString().slice(0, 10);

    $("herd-form").addEventListener("input", () => { selectedLevel = null; render(); });
    $("herd-form").addEventListener("submit", e => e.preventDefault());
    document.querySelectorAll("input[name=tolerance]").forEach(r =>
      r.addEventListener("change", () => { selectedLevel = null; render(); }));
    $("move").addEventListener("input", render);
    const pick = e => {
      const tr = e.target.closest("tr[data-level]");
      if (!tr) return;
      selectedLevel = Number(tr.dataset.level);
      render();
    };
    $("levels-table").addEventListener("click", pick);
    $("levels-table").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } });
    // Redraw charts in the right colors if the device switches light/dark mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    render();
  }
  init();
})();
