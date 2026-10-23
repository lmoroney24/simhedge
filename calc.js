// Sim Hedge math. Every dollar figure on the site comes from these functions.
// Prices are in $/cwt (dollars per hundred pounds), the way USDA publishes them.

const SimHedge = (() => {
  // --- Data access -------------------------------------------------------

  // Turns a compact data row into a readable object (see site/tools/fetch_lrp.py).
  function rowToObject(columns, row) {
    const obj = {};
    columns.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  }

  // Under 600 lbs is "Weight 1", 600-1,000 lbs is "Weight 2" in LRP.
  // Two different LRP products with different prices:
  //   Feeder cattle ("steers" / "heifers"), 100-1,000 lbs: LRP Feeder Cattle,
  //     paid on the CME Feeder Cattle Index. Under 600 lbs is "Weight 1".
  //   Fat cattle ("fat": fed steers & heifers going to slaughter), 1,000-1,800 lbs:
  //     LRP Fed Cattle, paid on the CME Live Cattle Index.
  const CLASSES = {
    steers:  { group: "feeder", min: 100,  max: 1000 },
    heifers: { group: "feeder", min: 100,  max: 1000 },
    fat:     { group: "fat",    min: 1000, max: 1800 },
  };
  const isFat = cattleClass => cattleClass === "fat";

  function weightRange(cattleClass) {
    return CLASSES[cattleClass] || CLASSES.steers;
  }

  function clampWeight(cattleClass, weightLbs) {
    const r = weightRange(cattleClass);
    return Math.min(r.max, Math.max(r.min, Number(weightLbs) || r.min));
  }

  function typeCode(cattleClass, weightLbs) {
    if (isFat(cattleClass)) return "820";
    const heavy = weightLbs >= 600;
    if (cattleClass === "heifers") return heavy ? "812" : "811";
    return heavy ? "810" : "809";
  }

  // The one price LRP pays on, and the matching futures contract size.
  function indexName(cattleClass) {
    return isFat(cattleClass) ? "CME Live Cattle Index" : "CME Feeder Cattle Index";
  }
  function futuresContract(cattleClass) {
    return isFat(cattleClass)
      ? { name: "CME Live Cattle", lbs: 40000 }
      : { name: "CME Feeder Cattle", lbs: 50000 };
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

  // Same result shape, for a plan length the farmer picked (e.g. 26 weeks).
  function matchWeeks(options, weeks, saleDate) {
    const levels = options.filter(o => o.weeks === weeks).sort((a, b) => b.level - a.level);
    if (!levels.length) return null;
    const endDate = levels[0].endDate;
    return { endDate, weeks, gapDays: daysBetween(endDate, saleDate), levels };
  }

  // Where the sale date falls against a plan's 60-day ownership window:
  //   "window": sale is in the last 60 days of coverage (LRP can pay)
  //   "early":  sale is more than 60 days before the end date (LRP won't pay)
  //   "after":  the plan ends before the sale (the last stretch isn't covered)
  function saleWindow(endDate, saleDate) {
    const opens = addDays(endDate, -OWNERSHIP_DAYS);
    if (saleDate < opens) return { status: "early", opens };
    if (saleDate > endDate) return { status: "after", opens, daysAfter: daysBetween(endDate, saleDate) };
    return { status: "window", opens };
  }

  // USDA's 60-day rule: you must still own the cattle during the last 60 days
  // of coverage. Sell more than 60 days before the end date and that coverage
  // ends with no payout, and the premium isn't refunded.
  // (UT Extension W312, Missouri Extension G459)
  const OWNERSHIP_DAYS = 60;
  function soldTooEarly(endDate, saleDate) {
    return daysBetween(saleDate, endDate) > OWNERSHIP_DAYS;
  }

  // Every plan length on sale today with its end date, shortest first.
  function availableLengths(options) {
    const byWeeks = new Map();
    for (const o of options) if (!byWeeks.has(o.weeks)) byWeeks.set(o.weeks, o.endDate);
    return [...byWeeks].map(([weeks, endDate]) => ({ weeks, endDate })).sort((a, b) => a.weeks - b.weeks);
  }

  // --- Breakeven calculator ------------------------------------------------
  // Breakeven ($/cwt) = what the cattle cost you, per head ÷ sale weight in cwt.
  //   spent, purchase: dollars, per head or for the whole group (per = "head" | "total")
  function breakevenFromCosts({ spent = 0, purchase = 0, per = "head", head, weight }) {
    const totalPerHead = per === "total" ? (spent + purchase) / Math.max(1, head) : spent + purchase;
    return { perHead: totalPerHead, perCwt: totalPerHead / (weight / 100) };
  }

  // Itemized all-in breakeven (the Breakeven page).
  //   costs: { name: dollars } entered per head or for the whole group (per)
  //   purchase: price paid for the cattle (same per/total basis), 0 if raised
  //   interestRate (e.g. 0.08) and months: interest on money tied up. The
  //     purchase price is tied up the whole time; other costs are spent
  //     gradually, so they count for half the time (a common budgeting rule).
  //   deathLossPct (e.g. 1.5): share of head that die; costs are spread over
  //     the head you actually sell.
  function breakevenDetail({ costs = {}, purchase = 0, per = "head", head, weight,
                             interestRate = 0, months = 0, deathLossPct = 0 }) {
    head = Math.max(1, head);
    const toTotal = v => (per === "total" ? v : v * head);
    const lines = Object.entries(costs).map(([name, v]) => ({ name, total: toTotal(Number(v) || 0) }));
    const purchaseTotal = toTotal(Number(purchase) || 0);
    const otherTotal = lines.reduce((t, l) => t + l.total, 0);
    const interest = purchaseTotal * interestRate * months / 12 + otherTotal * interestRate * (months / 12) / 2;
    const totalCost = purchaseTotal + otherTotal + interest;
    const soldHead = head * (1 - Math.min(99, Math.max(0, deathLossPct)) / 100);
    const soldCwt = soldHead * weight / 100;
    return {
      lines, purchaseTotal, interest, totalCost, soldHead, soldCwt,
      perHead: totalCost / soldHead,      // cost per head you sell
      perCwt: totalCost / soldCwt,        // the breakeven price
    };
  }

  // Sale price needed to clear a profit target ($ per head sold).
  function targetPrice(detail, profitPerHead, weight) {
    return (detail.perHead + profitPerHead) / (weight / 100);
  }

  // Cow-calf: what each calf has to carry of the cow herd's yearly cost.
  // weanedPct = calves weaned per 100 cows exposed.
  function cowCostPerCalf(costPerCow, weanedPct) {
    return weanedPct > 0 ? costPerCow / (weanedPct / 100) : 0;
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
  // Optional budget: herd.budgetPerHead = the most the farmer will spend on
  // coverage, $ per head. Plans over budget are left out of the pick.
  function costPerHead(plan, weight) {
    return plan.premium * weight / 100;
  }

  function recommend(levels, herd, tolerance) {
    if (tolerance === "compare" || !levels.length) return { plan: null, reason: "compare" };
    let pool = levels;
    if (herd.budgetPerHead > 0) {
      pool = levels.filter(p => costPerHead(p, herd.weight) <= herd.budgetPerHead + 1e-9);
      if (!pool.length) {
        const plan = levels.reduce((best, p) => (p.premium < best.premium ? p : best));
        return { plan, reason: "over-budget" };
      }
    }
    if (tolerance === "max") {
      const plan = pool.reduce((best, p) => (p.coverage > best.coverage ? p : best));
      return { plan, reason: "max" };
    }
    const safe = pool.filter(p => floorPrice(p, herd.basis) >= herd.breakeven);
    if (safe.length) {
      const plan = safe.reduce((best, p) => (p.premium < best.premium ? p : best));
      return { plan, reason: "cheapest-safe" };
    }
    // Nothing (affordable) protects breakeven: show the highest floor and say so.
    const plan = pool.reduce((best, p) =>
      floorPrice(p, herd.basis) > floorPrice(best, herd.basis) ? p : best);
    return { plan, reason: pool.length < levels.length ? "none-safe-budget" : "none-safe" };
  }

  // --- Inventory: one lot = one LRP endorsement ---------------------------

  // Everything the inventory page shows for one lot.
  //   lot: { cattleClass, head, weight, saleDate, breakeven, keep, coverage }
  //   lot.coverage (if the farmer recorded a plan they bought):
  //     { level, coverage, premium, endDate, weeks, effectiveDate }
  function lotStatus(data, lot) {
    const weight = clampWeight(lot.cattleClass, lot.weight);
    const cwt = herdCwt(lot.head, weight);           // insured weight: head x sale weight
    const code = typeCode(lot.cattleClass, weight);
    const match = matchEndorsement(currentOptions(data, code), lot.saleDate);
    const expEnd = match ? match.levels[0].expEnd : 0;
    const status = {
      code, typeName: data.types[code].name, cwt, match, expEnd,
      expectedValue: expEnd * cwt,                   // value at today's expected price
      floorValue: 0, premiumTotal: 0, warnings: [],
    };
    const warn = text => status.warnings.push(text);

    const range = weightRange(lot.cattleClass);
    if (lot.weight > range.max) {
      warn(isFat(lot.cattleClass)
        ? `Over ${range.max.toLocaleString()} lbs: above LRP Fed Cattle's weight range.`
        : "Over 1,000 lbs: these are fat cattle. Change the type to Fat cattle (LRP Fed Cattle).");
    }
    if (lot.weight < range.min) {
      warn(isFat(lot.cattleClass)
        ? "Under 1,000 lbs: these are feeder cattle. Change the type to Feeder steers or heifers."
        : `Under ${range.min} lbs: below LRP Feeder Cattle's weight range.`);
    }
    const c = lot.coverage;
    // The plan this lot has (if recorded) or would get today.
    status.planWeeks = c ? c.weeks : match && match.weeks;
    status.planEnd = c ? c.endDate : match && match.endDate;

    if (status.planEnd && soldTooEarly(status.planEnd, lot.saleDate)) {
      status.tooEarly = true;
      warn(`You plan to sell more than 60 days before this plan ends (${shortDate(status.planEnd)}). If you sell this early, LRP won't pay. Consider waiting to sell, or skipping LRP for this lot.`);
    } else if (!c && match && Math.abs(match.gapDays) > 30) {
      warn(`No LRP plan on sale today ends near this sale date. The closest ends ${longGap(match.gapDays)} your sale.`);
    }

    if (c) {
      status.floorValue = c.coverage * cwt;          // the price floor, in dollars
      status.premiumTotal = c.premium * cwt;         // farmer's share, billed at the end of coverage
      const gap = daysBetween(c.endDate, lot.saleDate);
      if (Math.abs(gap) > 21 && !status.tooEarly) warn(`Coverage ends ${longGap(gap)} your sale date. Prices can move in between.`);
      if (c.coverage - c.premium < lot.breakeven) {
        warn("This plan's floor, minus its cost, is below your breakeven.");
      }
    }
    return status;
  }

  function shortDate(iso) {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function longGap(days) {
    const weeks = Math.round(Math.abs(days) / 7);
    const amount = weeks >= 2 ? `${weeks} weeks` : `${Math.abs(days)} days`;
    return `${amount} ${days > 0 ? "before" : "after"}`;
  }

  // Totals across lots. Lots kept as replacements are left out: LRP never covers them.
  function inventorySummary(data, lots) {
    const forSale = lots.filter(l => !l.keep);
    const rows = forSale.map(l => ({ lot: l, s: lotStatus(data, l) }));
    const sum = f => rows.reduce((t, r) => t + f(r), 0);
    return {
      rows,
      lots: forSale.length,
      head: sum(r => r.lot.head),
      expectedValue: sum(r => r.s.expectedValue),
      protectedValue: sum(r => (r.lot.coverage ? r.s.expectedValue : 0)),
      floorValue: sum(r => r.s.floorValue),
      premiumTotal: sum(r => r.s.premiumTotal),
      coveredLots: rows.filter(r => r.lot.coverage).length,
    };
  }

  // --- My coverage: one covered lot (demo dashboard) ----------------------

  function addDays(iso, days) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // USDA's actual ending value for an end date, from the history data
  // (stored for Steers 600-1,000 lbs; other types scale by their factor).
  function actualEndingValue(data, endDate, factor, cattleClass) {
    // Fat cattle use the CME Live Cattle Index, kept separately.
    if (isFat(cattleClass)) {
      const v = (data.fedEndingValues || {})[endDate];
      return v == null ? null : v * factor;
    }
    for (const month of data.history) {
      for (const r of month.rows) {
        const row = rowToObject(data.columns, r);
        if (row.endDate === endDate && row.actualEnd != null) return row.actualEnd * factor;
      }
    }
    return null;
  }

  // Status, key dates and money for a lot with coverage, as of `today` (YYYY-MM-DD).
  //   Sell window: the last 60 days before the end date.
  //   Claim deadline: 60 days after the end date (Missouri Extension G459).
  function coverageStatus(data, lot, today) {
    const c = lot.coverage;
    const weight = clampWeight(lot.cattleClass, lot.weight);
    const cwt = herdCwt(lot.head, weight);
    const code = typeCode(lot.cattleClass, weight);
    const type = data.types[code];
    const s = {
      code, typeName: type.name, cwt, lbs: cwt * 100,
      sellWindowOpens: addDays(c.endDate, -OWNERSHIP_DAYS),
      claimDeadline: addDays(c.endDate, OWNERSHIP_DAYS),
      owe: c.premium * cwt,                                       // farmer's share, billed at the end
      usdaPays: c.cost != null ? (c.cost - c.premium) * cwt : null, // the subsidy
      todayEstimate: null, actualEnd: null, payout: null, net: null,
    };
    if (today > c.endDate) s.status = "ended";
    else if (today >= s.sellWindowOpens) s.status = "window";
    else s.status = "active";

    if (s.status === "ended") {
      s.actualEnd = actualEndingValue(data, c.endDate, type.factor, lot.cattleClass);
      if (s.actualEnd != null) {
        s.payout = Math.max(0, c.coverage - s.actualEnd) * cwt;
        s.net = s.payout - s.owe;
      }
    } else {
      // Today's expected ending value for the same end date and cattle type.
      // If no plan on sale today ends that day, use the closest end date
      // within 60 days and say which date it is.
      const ends = currentOptions(data, code);
      let same = ends.find(o => o.endDate === c.endDate);
      if (!same && ends.length) {
        const near = ends.reduce((a, b) =>
          Math.abs(daysBetween(c.endDate, b.endDate)) < Math.abs(daysBetween(c.endDate, a.endDate)) ? b : a);
        if (Math.abs(daysBetween(c.endDate, near.endDate)) <= 60) same = near;
      }
      if (same) {
        s.todayEstimate = same.expEnd;
        s.estimateEndDate = same.endDate;
      }
    }
    return s;
  }

  // CME Feeder Cattle futures: one contract is 50,000 lbs (Live Cattle: 40,000).
  const FUTURES_CONTRACT_LBS = 50000;

  return {
    typeCode, currentOptions, matchEndorsement, matchWeeks, saleWindow, costPerHead, herdCwt, outcome, floorPrice,
    subsidyShare, recommend, daysBetween, rowToObject, FUTURES_CONTRACT_LBS,
    isFat, weightRange, clampWeight, indexName, futuresContract, breakevenFromCosts,
    breakevenDetail, targetPrice, cowCostPerCalf,
    lotStatus, inventorySummary, soldTooEarly, availableLengths, OWNERSHIP_DAYS,
    coverageStatus, actualEndingValue, addDays,
  };
})();

if (typeof module !== "undefined") module.exports = SimHedge;
