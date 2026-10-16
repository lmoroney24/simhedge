// Sim Hedge math. Every dollar figure on the site comes from these functions.
// Prices are in $/cwt (dollars per hundred pounds), the way USDA publishes them.

const SimHedge = (() => {
  // --- Data access -------------------------------------------------------

  // Turns a compact data row into a readable object (see tools/fetch_lrp.py).
  function rowToObject(columns, row) {
    const obj = {};
    columns.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  }

  // Under 600 lbs is "Weight 1", 600-1,000 lbs is "Weight 2" in LRP.
  function typeCode(cattleClass, weightLbs) {
    const heavy = weightLbs >= 600;
    if (cattleClass === "heifers") return heavy ? "812" : "811";
    return heavy ? "810" : "809";
  }

  // All of today's LRP choices for one cattle type.
  function currentOptions(data, code) {
    return data.current.rows
      .filter(r => r[0] === code)
      .map(r => rowToObject(data.columns, r.slice(1)));
  }

  function daysBetween(isoA, isoB) {
    return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
  }

  // Picks the endorsement (insurance end date) closest to the planned sale date.
  function matchEndorsement(options, saleDate) {
    const ends = [...new Set(options.map(o => o.endDate))];
    if (!ends.length) return null;
    ends.sort((a, b) => Math.abs(daysBetween(a, saleDate)) - Math.abs(daysBetween(b, saleDate)));
    const endDate = ends[0];
    const levels = options.filter(o => o.endDate === endDate).sort((a, b) => b.level - a.level);
    return { endDate, weeks: levels[0].weeks, gapDays: daysBetween(endDate, saleDate), levels };
  }

  // --- The core math -----------------------------------------------------

  // Hundredweight insured: 40 head x 750 lbs = 30,000 lbs = 300 cwt.
  function herdCwt(head, weightLbs) {
    return head * weightLbs / 100;
  }

  // What the farm ends up with at sale time, for one price outcome.
  //   indexPrice: the USDA ending value for this cattle type, $/cwt
  //   plan: an LRP coverage row, or null for "no coverage"
  function outcome(herd, indexPrice, plan) {
    const cwt = herdCwt(herd.head, herd.weight);
    const salePrice = indexPrice + herd.basis;              // local price = index + basis
    const saleRevenue = cwt * salePrice;
    const payout = plan ? cwt * Math.max(0, plan.coverage - indexPrice) : 0;
    const premium = plan ? cwt * plan.premium : 0;          // farmer's share, after USDA subsidy
    const net = saleRevenue + payout - premium;
    const cost = cwt * herd.breakeven;
    return { cwt, salePrice, saleRevenue, payout, premium, net, profit: net - cost };
  }

  // The worst price per cwt the farm can end up with under a plan
  // (if the local price tracks the index): coverage + basis - premium.
  function floorPrice(plan, basis) {
    return plan.coverage + basis - plan.premium;
  }

  function subsidyShare(plan) {
    return plan.cost > 0 ? 1 - plan.premium / plan.cost : 0;
  }

  // --- Risk tolerance ----------------------------------------------------

  // "cheapest": lowest premium whose floor still covers breakeven.
  // "max": highest coverage price available, whatever it costs.
  // "compare": no single pick; the site shows every level.
  function recommend(levels, herd, tolerance) {
    if (tolerance === "compare" || !levels.length) return { plan: null, reason: "compare" };
    if (tolerance === "max") {
      const plan = levels.reduce((best, p) => (p.coverage > best.coverage ? p : best));
      return { plan, reason: "max" };
    }
    const safe = levels.filter(p => floorPrice(p, herd.basis) >= herd.breakeven);
    if (safe.length) {
      const plan = safe.reduce((best, p) => (p.premium < best.premium ? p : best));
      return { plan, reason: "cheapest-safe" };
    }
    // Nothing protects breakeven: show the plan with the highest floor and say so.
    const plan = levels.reduce((best, p) =>
      floorPrice(p, herd.basis) > floorPrice(best, herd.basis) ? p : best);
    return { plan, reason: "none-safe" };
  }

  // --- History check (backtest) ------------------------------------------

  // For each past month, finds the LRP plan a producer could have bought
  // (same length and coverage level as today's pick) and what it actually paid.
  // History is stored for Steers 600-1,000 lbs (factor 1.00); other types are
  // that same national price times their USDA price adjustment factor.
  function backtest(data, herd, weeks, level, factor) {
    const cwt = herdCwt(herd.head, herd.weight);
    const results = [];
    for (const month of data.history) {
      const rows = month.rows.map(r => rowToObject(data.columns, r));
      // Before 2023 USDA offered uneven levels (99.3%, 98.1%, ...), so use the
      // closest one, as long as it's within 2.5 points of today's pick.
      const candidates = rows.filter(r => r.weeks === weeks && r.actualEnd != null);
      if (!candidates.length) continue;
      const match = candidates.reduce((a, b) => Math.abs(b.level - level) < Math.abs(a.level - level) ? b : a);
      if (Math.abs(match.level - level) > 0.025) continue;
      const coverage = match.coverage * factor;
      const actualEnd = match.actualEnd * factor;
      const premium = match.premium * factor;
      const payout = cwt * Math.max(0, coverage - actualEnd);
      results.push({
        bought: month.effectiveDate,
        ended: match.endDate,
        level: match.level, coverage, actualEnd, premiumPerCwt: premium,
        payout,
        premium: cwt * premium,
        net: payout - cwt * premium,
      });
    }
    return results;
  }

  // CME Feeder Cattle futures: one contract is 50,000 lbs.
  const FUTURES_CONTRACT_LBS = 50000;

  return {
    typeCode, currentOptions, matchEndorsement, herdCwt, outcome, floorPrice,
    subsidyShare, recommend, backtest, daysBetween, rowToObject, FUTURES_CONTRACT_LBS,
  };
})();

if (typeof module !== "undefined") module.exports = SimHedge;
