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
  function line(container, { series, xFormat, yFormat, marker, tipTitle, xTitle, yTitle }) {
    container.innerHTML = "";
    const W = 760, H = 320, m = { t: 12, r: 16, b: 52, l: 92 };
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
      el("text", { x: X(t), y: H - m.b + 18, "text-anchor": "middle" }, svg).textContent = xFormat(t);
    }
    axisTitles(svg, W, H, m, xTitle, yTitle);
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

  function axisTitles(svg, W, H, m, xTitle, yTitle) {
    if (xTitle) el("text", { x: m.l + (W - m.l - m.r) / 2, y: H - 6, "text-anchor": "middle", class: "axis-title" }, svg).textContent = xTitle;
    if (yTitle) el("text", { x: 0, y: 0, "text-anchor": "middle", class: "axis-title",
      transform: `translate(14 ${m.t + (H - m.t - m.b) / 2}) rotate(-90)` }, svg).textContent = yTitle;
  }

  // Dot chart for the coverage trade-off: each point is one coverage level.
  // points: [{x, y, label, selected, tip, id}], hLine: {y, label}, vLine: {x, label}
  function scatter(container, { points, xFormat, yFormat, xTitle, yTitle, hLine, vLine, color, onPick }) {
    container.innerHTML = "";
    const W = 760, H = 320, m = { t: 16, r: 24, b: 52, l: 92 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, container);
    const xsAll = points.map(p => p.x).concat(vLine ? [vLine.x] : []);
    const ysAll = points.map(p => p.y).concat(hLine ? [hLine.y] : []);
    const xT = niceTicks(0, Math.max(...xsAll) * 1.05, 6);
    const yT = niceTicks(Math.min(...ysAll) * 0.98, Math.max(...ysAll) * 1.01, 5);
    const xMin = xT[0], xMax = xT[xT.length - 1], yMin = yT[0], yMax = yT[yT.length - 1];
    const X = v => m.l + (v - xMin) / (xMax - xMin) * (W - m.l - m.r);
    const Y = v => H - m.b - (v - yMin) / (yMax - yMin) * (H - m.t - m.b);
    for (const t of yT) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: "grid-line" }, svg);
      el("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = yFormat(t);
    }
    for (const t of xT) el("text", { x: X(t), y: H - m.b + 18, "text-anchor": "middle" }, svg).textContent = xFormat(t);
    el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis-line" }, svg);
    axisTitles(svg, W, H, m, xTitle, yTitle);
    const ref = cssVar("--ink-2");
    if (hLine) {
      el("line", { x1: m.l, x2: W - m.r, y1: Y(hLine.y), y2: Y(hLine.y), stroke: ref, "stroke-dasharray": "5 4" }, svg);
      el("text", { x: W - m.r, y: Y(hLine.y) - 6, "text-anchor": "end", class: "ref-label" }, svg).textContent = hLine.label;
    }
    if (vLine) {
      el("line", { x1: X(vLine.x), x2: X(vLine.x), y1: m.t, y2: H - m.b, stroke: ref, "stroke-dasharray": "5 4" }, svg);
      el("text", { x: X(vLine.x) + 6, y: m.t + 12, class: "ref-label" }, svg).textContent = vLine.label;
    }
    // connecting line, then dots (selected one bigger, with a ring)
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    el("path", { d: sorted.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(""),
      fill: "none", stroke: color, "stroke-width": 2, opacity: .45 }, svg);
    for (const p of points) {
      const g = el("g", { class: "dot", tabindex: 0, role: "button", "aria-label": p.label }, svg);
      el("circle", { cx: X(p.x), cy: Y(p.y), r: 14, fill: "transparent" }, g);   // bigger hit area
      el("circle", { cx: X(p.x), cy: Y(p.y), r: p.selected ? 8 : 5, fill: color,
        stroke: cssVar("--card"), "stroke-width": 2 }, g);
      if (p.selected) el("circle", { cx: X(p.x), cy: Y(p.y), r: 12, fill: "none", stroke: color, "stroke-width": 1.5 }, g);
      if (p.selected || p.labelAlways) {
        el("text", { x: X(p.x), y: Y(p.y) - 16, "text-anchor": "middle", class: "dot-label" }, g).textContent = p.label;
      }
      g.addEventListener("mousemove", evt => showTip(evt, p.tip));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("click", () => { hideTip(); onPick && onPick(p.id); });
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick && onPick(p.id); } });
    }
  }

  return { line, scatter, cssVar };
})();
