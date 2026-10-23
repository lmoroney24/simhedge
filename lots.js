// Saves the farmer's lots in this browser (localStorage).
// No accounts, no server: the lots stay on this one device and disappear if
// the browser's site data is cleared. Every access is wrapped in try/catch
// because some browsers (private windows, strict settings) block storage.

const Lots = (() => {
  const KEY = "simhedge.lots.v1";

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  // Returns false if the browser wouldn't let us save.
  function save(lots) {
    try {
      localStorage.setItem(KEY, JSON.stringify(lots));
      return true;
    } catch {
      return false;
    }
  }

  function find(id) {
    return load().find(l => l.id === id) || null;
  }

  function upsert(lot) {
    const lots = load();
    const i = lots.findIndex(l => l.id === lot.id);
    if (i >= 0) lots[i] = lot; else lots.push(lot);
    return save(lots);
  }

  function remove(id) {
    return save(load().filter(l => l.id !== id));
  }

  // A recorded LRP plan only fits the cattle type and weight class it was bought
  // for. When a lot is edited, keep its plan only if it still fits.
  function fittingCoverage(old, lot) {
    if (!old || !old.coverage || lot.keep) return null;
    const code = l => SimHedge.typeCode(l.cattleClass, SimHedge.clampWeight(l.cattleClass, l.weight));
    return code(old) === code(lot) ? old.coverage : null;
  }

  function newId() {
    return "lot-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  // The example farm from docs/inventory-page.md (made-up numbers).
  // Sale dates are set relative to the USDA data date so they always line up
  // with plans that are on sale.
  function exampleLots(dataDate) {
    const plus = days => {
      const d = new Date(dataDate + "T12:00:00");
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };
    return [
      { id: newId(), name: "Fall steers", cattleClass: "steers", head: 18, weight: 550, saleDate: plus(91), breakeven: 290, keep: false, coverage: null },
      { id: newId(), name: "Fall heifers", cattleClass: "heifers", head: 12, weight: 500, saleDate: plus(91), breakeven: 285, keep: false, coverage: null },
      { id: newId(), name: "Kept heifers", cattleClass: "heifers", head: 6, weight: 500, saleDate: plus(91), breakeven: 0, keep: true, coverage: null },
      { id: newId(), name: "Backgrounded steers", cattleClass: "steers", head: 4, weight: 750, saleDate: plus(119), breakeven: 300, keep: false, coverage: null },
    ];
  }

  return { load, save, find, upsert, remove, fittingCoverage, newId, exampleLots };
})();
