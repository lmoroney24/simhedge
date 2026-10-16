// Small hand-built SVG charts (no libraries, so the demo works offline).

const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const tooltip = () => document.getElementById("tooltip");

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
    const ticks = [];
    const top = Math.ceil(max / step - 1e-9) * step; // always reach past the tallest value
    for (let t = Math.floor(min / step) * step; t <= top + 1e-9; t += step) ticks.push(t);
    return ticks;
  }

  function showTip(evt, html) {
    const tip = tooltip();
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip() { tooltip().hidden = true; }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Line chart with a hover crosshair.
  // series: [{name, color, values:[{x,y}], dashed}], marker: x value to highlight
  function line(container, { series, xFormat, yFormat, marker, tipTitle }) {
    container.innerHTML = "";
    const W = 760, H = 300, m = { t: 12, r: 16, b: 32, l: 76 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    const xs = series[0].values.map(p => p.x);
    const ys = series.flatMap(s => s.values.map(p => p.y)).concat([0]);
    const yT = niceTicks(Math.min(...ys), Math.max(...ys));
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = yT[0], yMax = yT[yT.length - 1];
    const X = v => m.l + (v - xMin) / (xMax - xMin) * (W - m.l - m.r);
    const Y = v => H - m.b - (v - yMin) / (yMax - yMin) * (H - m.t - m.b);

    for (const t of yT) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, svg);
      el("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = yFormat(t);
    }
    for (const t of niceTicks(xMin, xMax, 6)) {
      el("text", { x: X(t), y: H - 10, "text-anchor": "middle" }, svg).textContent = xFormat(t);
    }
    if (marker != null) {
      el("line", { x1: X(marker), x2: X(marker), y1: m.t, y2: H - m.b, stroke: cssVar("--ink-3"), "stroke-dasharray": "3 3" }, svg);
    }
    for (const s of series) {
      const d = s.values.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round",
        "stroke-dasharray": s.dashed ? "6 4" : "none" }, svg);
      if (marker != null) {
        const p = s.values.find(v => v.x === marker);
        if (p) el("circle", { cx: X(p.x), cy: Y(p.y), r: 5, fill: s.color, stroke: cssVar("--card"), "stroke-width": 2 }, svg);
      }
    }

    // Hover layer
    const cross = el("line", { y1: m.t, y2: H - m.b, stroke: cssVar("--ink-2"), visibility: "hidden" }, svg);
    const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", evt => {
      const box = svg.getBoundingClientRect();
      const px = (evt.clientX - box.left) / box.width * W;
      const xv = xMin + (px - m.l) / (W - m.l - m.r) * (xMax - xMin);
      const i = xs.reduce((best, x, k) => Math.abs(x - xv) < Math.abs(xs[best] - xv) ? k : best, 0);
      cross.setAttribute("x1", X(xs[i])); cross.setAttribute("x2", X(xs[i]));
      cross.setAttribute("visibility", "visible");
      const rows = series.map(s =>
        `<div class="t-row"><span><i style="background:${s.color}"></i>${s.name}</span><b>${yFormat(s.values[i].y, true)}</b></div>`).join("");
      showTip(evt, `<div class="t-head">${tipTitle(xs[i])}</div>${rows}`);
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  }

  // Bar chart for positive/negative values (bars grow from zero).
  // bars: [{label, value, tip}]
  function bars(container, { bars, yFormat, labelEvery = 1 }) {
    container.innerHTML = "";
    if (!bars.length) return;
    const W = 760, H = 280, m = { t: 12, r: 12, b: 40, l: 76 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    const vals = bars.map(b => b.value).concat([0]);
    const yT = niceTicks(Math.min(...vals), Math.max(...vals));
    const yMin = yT[0], yMax = yT[yT.length - 1];
    const Y = v => H - m.b - (v - yMin) / (yMax - yMin) * (H - m.t - m.b);
    const slot = (W - m.l - m.r) / bars.length;
    const bw = Math.max(2, slot - 2); // 2px gap between bars

    for (const t of yT) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? "axis-line" : "grid-line" }, svg);
      el("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = yFormat(t);
    }
    const pos = cssVar("--pos"), neg = cssVar("--neg");
    bars.forEach((b, i) => {
      const x = m.l + i * slot + 1;
      const y0 = Y(0), y1 = Y(b.value);
      const h = Math.max(Math.abs(y1 - y0), b.value === 0 ? 0 : 1);
      const top = b.value >= 0 ? y0 - h : y0;
      const r = Math.min(4, bw / 2, h);
      // rounded on the data end, square on the zero line
      const d = b.value >= 0
        ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
        : `M${x},${y0}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + bw - r}Q${x + bw},${top + h} ${x + bw},${top + h - r}V${y0}Z`;
      el("path", { d, fill: b.value >= 0 ? pos : neg }, svg);
      if (i % labelEvery === 0) {
        el("text", { x: x + bw / 2, y: H - 22, "text-anchor": "middle" }, svg).textContent = b.label;
      }
      const hit = el("rect", { x: m.l + i * slot, y: m.t, width: slot, height: H - m.t - m.b, fill: "transparent" }, svg);
      hit.addEventListener("mousemove", evt => showTip(evt, b.tip));
      hit.addEventListener("mouseleave", hideTip);
    });
  }

  return { line, bars, cssVar };
})();
