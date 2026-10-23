// My coverage (demo): a dashboard of the lots that have LRP coverage, their
// key dates, and what they cost. Sample data only; nothing is sent anywhere.

(() => {
  const DATA = window.LRP_DATA;
  const $ = id => document.getElementById(id);

  const money = v => (v < 0 ? "-$" : "$") + Math.round(Math.abs(v)).toLocaleString("en-US");
  const cwtPrice = v => "$" + v.toFixed(2);
  const pct = v => +(v * 100).toFixed(1) + "%";
  const longDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const PILLS = {
    active: ["Active", "pill-active"],
    window: ["Sell window open", "pill-window"],
    ended: ["Ended, check payout", "pill-ended"],
  };

  function render() {
    const lots = Lots.load();
    const today = todayIso();
    const covered = lots.filter(l => !l.keep && l.coverage)
      .map(lot => ({ lot, s: SimHedge.coverageStatus(DATA, lot, today) }));
    const uncovered = lots.filter(l => !l.keep && !l.coverage);

    $("empty").hidden = covered.length > 0;
    $("dashboard").hidden = covered.length === 0;
    if (!covered.length) return;

    renderPolicy(covered);
    renderCovered(covered);
    renderDates(covered, today);
    renderPlanned(uncovered);
  }

  // --- 1. Policy summary ---------------------------------------------------
  function renderPolicy(covered) {
    const sum = f => covered.reduce((t, x) => t + f(x), 0);
    const usda = covered.every(x => x.s.usdaPays != null) ? money(sum(x => x.s.usdaPays)) : "–";
    $("policy-tiles").innerHTML = [
      tile("Covered lots", covered.length, `${sum(x => x.lot.head).toLocaleString()} head`),
      tile("Insured weight", `${sum(x => x.s.cwt).toLocaleString()} cwt`, `${sum(x => x.s.lbs).toLocaleString()} lbs`),
      tile("You owe at the end", money(sum(x => x.s.owe)), "your share of the premium"),
      tile("USDA pays", usda, "the premium subsidy"),
    ].join("");
  }

  function tile(label, value, sub) {
    return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  }

  // --- 2. Covered lots -----------------------------------------------------
  function renderCovered(covered) {
    $("covered-list").innerHTML = covered.map(({ lot, s }) => {
      const c = lot.coverage;
      const [pillText, pillClass] = PILLS[s.status];
      return `<article class="cover-card">
        <div class="cover-head">
          <div>
            <h3>${esc(lot.name)}</h3>
            <div class="sub">${lot.head} head · ${s.typeName}</div>
          </div>
          <div class="pills">
            <span class="pill ${pillClass}">${pillText}</span>
            <span class="badge good">Covered (demo)</span>
          </div>
        </div>
        <dl class="cover-facts">
          <div><dt>Insured weight</dt><dd>${s.cwt.toLocaleString()} cwt <span class="sub">(${s.lbs.toLocaleString()} lbs)</span></dd></div>
          <div><dt>Coverage</dt><dd>${pct(c.level)} · ${cwtPrice(c.coverage)}/cwt floor</dd></div>
          <div><dt>Plan</dt><dd>${c.weeks}-week plan<span class="sub"><br>${longDate(c.effectiveDate)} to ${longDate(c.endDate)}</span></dd></div>
          <div><dt>You owe</dt><dd>${money(s.owe)} <span class="sub">billed ${longDate(c.endDate)}</span></dd></div>
          <div><dt>USDA pays</dt><dd>${s.usdaPays != null ? money(s.usdaPays) : "–"}</dd></div>
        </dl>
        <p class="cover-market">${marketLine(c, s)}</p>
      </article>`;
    }).join("");
  }

  function marketLine(c, s) {
    if (s.status === "ended") {
      if (s.actualEnd == null) return "Coverage has ended. Waiting for USDA's ending value.";
      return `USDA's ending value: ${cwtPrice(s.actualEnd)}/cwt. ` +
        (s.payout > 0
          ? `LRP pays <strong>${money(s.payout)}</strong>, minus the ${money(s.owe)} premium = <strong>${money(s.net)}</strong> net.`
          : `That's above your floor, so there's no payout. The ${money(s.owe)} premium is still owed.`);
    }
    if (s.todayEstimate == null) return "No current market estimate for this end date.";
    const diff = s.todayEstimate - c.coverage;
    const near = s.estimateEndDate !== c.endDate ? ` for cattle ending ${longDate(s.estimateEndDate)}, the closest date USDA prices today` : "";
    return `Today's market estimate${near} (${cwtPrice(s.todayEstimate)}/cwt) is <strong>${cwtPrice(Math.abs(diff))} ` +
      `${diff >= 0 ? "above" : "below"}</strong> your floor. ` +
      (diff >= 0 ? "LRP wouldn't pay at today's estimate." : `At today's estimate, LRP would pay about ${money(-diff * s.cwt)}.`) +
      ` <span class="sub">Today's estimate, not a prediction.</span>`;
  }

  // --- 3. Key dates --------------------------------------------------------
  function renderDates(covered, today) {
    const events = [];
    for (const { lot, s } of covered) {
      const name = esc(lot.name), end = lot.coverage.endDate;
      events.push({ date: s.sellWindowOpens, text: `<strong>${name}: sell window opens.</strong> Sell between ${longDate(s.sellWindowOpens)} and ${longDate(end)} to keep your coverage.` });
      events.push({ date: end, text: `<strong>${name}: coverage ends and the premium is billed</strong> (${money(s.owe)}).` });
      events.push({ date: s.claimDeadline, text: `<strong>${name}: claim deadline</strong> if it ends below your floor. File a Notice of Probable Loss with your agent by ${longDate(s.claimDeadline)}.` });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    $("date-list").innerHTML = events.map(e =>
      `<li class="${e.date < today ? "past" : ""}"><time>${longDate(e.date)}</time><span>${e.text}</span></li>`).join("");
  }

  // --- 4. Lots without coverage --------------------------------------------
  function renderPlanned(uncovered) {
    $("planned-list").innerHTML = uncovered.length
      ? `<ul class="planned">${uncovered.map(lot => `
          <li>
            <div><strong>${esc(lot.name)}</strong> <span class="sub">${lot.head} head, sells ${longDate(lot.saleDate)}</span>
              <div class="sub">Planned coverage: none yet</div></div>
            <div class="form-actions">
              <a class="btn btn-small btn-quiet" href="lrp.html?lot=${encodeURIComponent(lot.id)}">Find coverage</a>
              <button type="button" class="btn btn-small" data-buy>Buy through Sim Hedge</button>
            </div>
          </li>`).join("")}</ul>`
      : `<p class="note">Every lot you're selling has coverage.</p>`;
  }

  // --- Demo scenario --------------------------------------------------------
  // A sample farm that shows every stage, built from REAL USDA numbers:
  //  - Spring steers: plan from Apr 1, 2026 that ended Aug 26, 2026 (real payout)
  //  - Fall steers: plan from Jul 1, 2026 ending Nov 25, 2026 (sell window)
  //  - Backgrounded steers: a plan on sale today (active)
  //  - Fall heifers: no coverage yet; Kept heifers: replacements
  // Past plans come from the history data (Steers 600-1,000 lbs, so these lots
  // use that weight class and need no scaling).
  function pastPlan(effectiveDate, endDate) {
    const month = DATA.history.find(m => m.effectiveDate === effectiveDate);
    if (!month) return null;
    const rows = month.rows.map(r => SimHedge.rowToObject(DATA.columns, r)).filter(r => r.endDate === endDate);
    if (!rows.length) return null;
    const p = rows.reduce((a, b) => Math.abs(b.level - 0.95) < Math.abs(a.level - 0.95) ? b : a);
    return { level: p.level, coverage: p.coverage, premium: p.premium, cost: p.cost, endDate, weeks: p.weeks, effectiveDate };
  }

  function todayPlan(lot) {
    const code = SimHedge.typeCode(lot.cattleClass, SimHedge.clampWeight(lot.cattleClass, lot.weight));
    const match = SimHedge.matchEndorsement(SimHedge.currentOptions(DATA, code), lot.saleDate);
    const p = match.levels.reduce((a, b) => Math.abs(b.level - 0.95) < Math.abs(a.level - 0.95) ? b : a);
    return { level: p.level, coverage: p.coverage, premium: p.premium, cost: p.cost,
      endDate: match.endDate, weeks: match.weeks, effectiveDate: DATA.current.effectiveDate };
  }

  function demoLots() {
    const plus = days => SimHedge.addDays(DATA.current.effectiveDate, days);
    const lot = (name, cattleClass, head, weight, saleDate, breakeven, extra = {}) =>
      ({ id: Lots.newId(), name, cattleClass, head, weight, saleDate, breakeven, keep: false, coverage: null, ...extra });
    const lots = [
      lot("Spring steers", "steers", 20, 750, "2026-08-20", 300, { coverage: pastPlan("2026-04-01", "2026-08-26") }),
      lot("Fall steers", "steers", 18, 650, "2026-11-20", 300, { coverage: pastPlan("2026-07-01", "2026-11-25") }),
      lot("Backgrounded steers", "steers", 4, 750, plus(119), 300),
      lot("Fall heifers", "heifers", 12, 500, plus(91), 285),
      lot("Kept heifers", "heifers", 6, 500, plus(91), 0, { keep: true }),
    ];
    lots[2].coverage = todayPlan(lots[2]);
    return lots;
  }

  function init() {
    if (!DATA) {
      document.querySelector("main").innerHTML = `<section class="card"><h2>Data missing</h2><p>Run <code>python3 site/tools/fetch_lrp.py</code> to download USDA LRP data.</p></section>`;
      return;
    }
    $("reset-demo").addEventListener("click", e => {
      const b = e.currentTarget;
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to reset all lots"; return; }
      Lots.save(demoLots());
      b.dataset.armed = ""; b.textContent = "Reset demo scenario";
      render();
    });
    const loadBtn = $("load-demo");
    if (Lots.load().length) {
      $("load-demo-note").textContent = "This replaces the lots on your inventory page with the demo farm.";
    }
    loadBtn.addEventListener("click", () => {
      // If there are lots already, ask for a second click before replacing them.
      if (Lots.load().length && !loadBtn.dataset.armed) {
        loadBtn.dataset.armed = "1";
        loadBtn.textContent = "Click again to replace your lots";
        return;
      }
      if (!Lots.save(demoLots())) {
        $("load-demo-note").textContent = "This browser isn't letting Sim Hedge save (private window or strict privacy settings).";
        return;
      }
      render();
    });
    // "Buy through Sim Hedge" only shows a message. Nothing is sent.
    $("planned-list").addEventListener("click", e => {
      if (!e.target.closest("[data-buy]")) return;
      const msg = $("buy-message");
      msg.textContent = "Buying through Sim Hedge is coming soon. Once licensed, this will send your plan to us to submit to the insurance company. Nothing was sent.";
      msg.hidden = false;
    });
    render();
  }
  init();
})();
