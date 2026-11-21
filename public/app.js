/* global Chart */
// Dashboard USD/PEN. Sin build: JS plano que consume la API REST del mismo Worker.
"use strict";

const REFRESH_MS = 5 * 60 * 1000;
const LIMA_OFFSET = -5 * 3600; // Lima no usa horario de verano
const SESSION = { start: 9 * 3600, end: 13 * 3600 + 30 * 60 };

const fmtTime = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtDay = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "short",
});
const fmtFull = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtDate = new Intl.DateTimeFormat("es-PE", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const pen = (v, d = 4) => (typeof v === "number" ? `S/ ${v.toFixed(d)}` : "—");
const $ = (id) => document.getElementById(id);
const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const signed = (abs, pct) =>
  `${sign(abs)}${Math.abs(abs).toFixed(4)} (${sign(pct)}${Math.abs(pct).toFixed(2)} %)`;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dateToMs = (d) => Date.parse(`${d}T00:00:00Z`);

const state = {
  liveRange: "1d",
  bcrpRange: "6m",
  outliers: false,
  charts: {},
  timer: null,
  seq: { live: 0, bcrp: 0 },
};

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Estados vacíos y de error ----------
function showState(id, html, retry) {
  const el = $(id);
  el.innerHTML = html;
  el.hidden = false;
  if (retry) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Reintentar";
    b.addEventListener("click", retry);
    el.appendChild(b);
  }
}
const hideState = (id) => ($(id).hidden = true);

// ---------- Banda de la sesión interbancaria de Lima ----------
const sessionBand = {
  id: "sessionBand",
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts.enabled) return;
    const { ctx, chartArea: a, scales } = chart;
    const x = scales.x;
    const from = x.min / 1000;
    const to = x.max / 1000;
    ctx.save();
    ctx.fillStyle = css("--band");
    const firstDay = Math.floor((from + LIMA_OFFSET) / 86400) * 86400 - LIMA_OFFSET;
    for (let day = firstDay; day <= to; day += 86400) {
      const wd = new Date((day + LIMA_OFFSET) * 1000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const x0 = Math.max(x.getPixelForValue((day + SESSION.start) * 1000), a.left);
      const x1 = Math.min(x.getPixelForValue((day + SESSION.end) * 1000), a.right);
      if (x1 > x0) ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
    }
    ctx.restore();
  },
};

/** Ticks alineados a la hora local de Lima (múltiplos de `stepSec` desde la medianoche de Lima). */
function alignedTicks(stepSec) {
  return (scale) => {
    const from = scale.min / 1000;
    const to = scale.max / 1000;
    const first = Math.ceil((from + LIMA_OFFSET) / stepSec) * stepSec - LIMA_OFFSET;
    const ticks = [];
    for (let s = first; s <= to && ticks.length < 40; s += stepSec) ticks.push({ value: s * 1000 });
    scale.ticks = ticks;
  };
}

function baseOptions(xFormatter, tooltipTitle, xRange, stepSec) {
  const ink2 = css("--ink-2");
  const grid = css("--grid");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? false
      : { duration: 250 },
    // "nearest" en x: cada serie aporta su punto más cercano a la misma hora/fecha
    // (con "index" se mezclaban puntos de distintas fechas entre series).
    interaction: { mode: "nearest", axis: "x", intersect: false },
    scales: {
      x: {
        type: "linear",
        min: xRange[0],
        max: xRange[1],
        afterBuildTicks: alignedTicks(stepSec),
        grid: { display: false },
        border: { color: grid },
        ticks: { color: ink2, maxRotation: 0, autoSkipPadding: 16, callback: (v) => xFormatter(v) },
      },
      y: {
        grid: { color: grid },
        border: { display: false },
        title: { display: true, text: "S/ por US$", color: ink2 },
        ticks: { color: ink2, callback: (v) => Number(v).toFixed(4) },
      },
    },
    plugins: {
      legend: {
        position: "top",
        align: "end",
        labels: { color: ink2, usePointStyle: true, boxWidth: 8, boxHeight: 8 },
      },
      tooltip: {
        callbacks: {
          title: (items) => (items[0] ? tooltipTitle(items[0].parsed.x) : ""),
          label: (item) =>
            item.parsed.y === null
              ? ` ${item.dataset.label}: n.d.`
              : ` ${item.dataset.label}: ${pen(item.parsed.y)}`,
        },
      },
    },
  };
}

/** Inserta un null donde falten datos (> maxGapMs) para no unir con una recta los huecos. */
function withGaps(points, maxGapMs) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.y !== null && p.x - prev.x > maxGapMs) out.push({ x: prev.x + 1, y: null });
    out.push(p);
  }
  return out;
}

function lineDataset(label, color, data, dash) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: data.length === 1 ? 5 : 0, // con un solo dato, mostrar el punto
    pointHoverRadius: 5,
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: css("--surface"),
    tension: 0,
    spanGaps: false,
    borderDash: dash ?? [],
  };
}

function renderChart(key, canvasId, config) {
  const prev = state.charts[key];
  if (prev) prev.destroy();
  state.charts[key] = new Chart($(canvasId), config);
}

function renderTable(id, head, rows) {
  const t = $(id);
  const th = `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>`;
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  t.innerHTML = `${th}<tbody>${body}</tbody>`;
}

// ---------- Gráfico en vivo ----------
async function loadLive() {
  const seq = ++state.seq.live; // descarta respuestas viejas si el usuario cambió de rango
  const q = `range=${state.liveRange}${state.outliers ? "&include_outliers=true" : ""}`;
  let body;
  try {
    body = await getJson(`/api/live?${q}`);
    if (seq !== state.seq.live) return true;
  } catch {
    showState(
      "live-state",
      "<strong>No se pudo cargar la cotización.</strong><span>Revisa tu conexión.</span>",
      loadLive,
    );
    return false;
  }
  // Hueco > 3 intervalos (15 min en 1D/5D, 3 h en 1M) → se corta la línea.
  const gap = state.liveRange === "1m" ? 3 * 3600_000 : 15 * 60_000;
  const valid = withGaps(
    body.data.map((d) => ({ x: d.ts * 1000, y: d.price })),
    gap,
  );
  const out = (body.outliers ?? []).map((d) => ({ x: d.ts * 1000, y: d.price }));
  if (body.data.length === 0 && out.length === 0) {
    showState(
      "live-state",
      "<strong>Aún no hay lecturas en este rango.</strong><span>Las lecturas se toman cada 5 minutos mientras el mercado forex está abierto (de domingo 17:00 a viernes 17:00, hora de Nueva York).</span>",
    );
  } else hideState("live-state");

  const multiDay = state.liveRange !== "1d";
  const datasets = [lineDataset("USD/PEN en vivo", css("--series-1"), valid)];
  if (state.outliers) {
    datasets.push({
      label: "Atípico (excluido)",
      data: out,
      type: "scatter",
      showLine: false,
      pointStyle: "crossRot",
      pointRadius: 7,
      pointBorderWidth: 2,
      borderColor: css("--critical"),
      backgroundColor: css("--critical"),
    });
  }
  const step = { "1d": 3 * 3600, "5d": 86400, "1m": 7 * 86400 }[state.liveRange];
  const opts = baseOptions(
    (v) => (multiDay ? fmtDay.format(v) : fmtTime.format(v)),
    (v) => fmtFull.format(v),
    [body.from * 1000, body.to * 1000],
    step,
  );
  opts.plugins.sessionBand = { enabled: state.liveRange !== "1m" };
  opts.plugins.legend.display = state.outliers; // una sola serie: el título la nombra
  renderChart("live", "live-chart", {
    type: "line",
    data: { datasets },
    options: opts,
    plugins: [sessionBand],
  });

  const rows = [
    ...valid.filter((p) => p.y !== null).map((p) => [p, "válido"]),
    ...out.map((p) => [p, "atípico"]),
  ]
    .sort((a, b) => b[0].x - a[0].x)
    .map(([p, kind]) => [fmtFull.format(p.x), p.y.toFixed(4), kind]);
  renderTable("live-table", ["Fecha y hora (Lima)", "Precio (S/)", "Estado"], rows);
  return true;
}

// ---------- Gráfico BCRP ----------
async function loadBcrp() {
  const seq = ++state.seq.bcrp;
  let body;
  try {
    body = await getJson(`/api/bcrp?range=${state.bcrpRange}`);
    if (seq !== state.seq.bcrp) return true;
  } catch {
    showState(
      "bcrp-state",
      "<strong>No se pudo cargar el BCRP.</strong><span>Revisa tu conexión.</span>",
      loadBcrp,
    );
    return false;
  }
  if (body.data.length === 0) {
    showState(
      "bcrp-state",
      "<strong>Sin datos del BCRP en este rango.</strong><span>El BCRP publica en días hábiles.</span>",
    );
  } else hideState("bcrp-state");
  // Se conservan los null (n.d.) para que compra y venta queden alineadas por fecha.
  const pts = (k) => body.data.map((d) => ({ x: dateToMs(d.date), y: d[k] }));
  const datasets = [
    lineDataset("Compra", css("--series-1"), pts("compra")),
    lineDataset("Venta", css("--series-2"), pts("venta"), [6, 3]), // trazo distinto: no solo color
  ];
  const dayFmt = new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  });
  const step = { "1m": 7 * 86400, "6m": 30 * 86400, "1y": 61 * 86400 }[state.bcrpRange];
  const opts = baseOptions(
    (v) => dayFmt.format(v),
    (v) => fmtDate.format(v),
    [dateToMs(body.from), dateToMs(body.to)],
    step,
  );
  renderChart("bcrp", "bcrp-chart", { type: "line", data: { datasets }, options: opts });
  const rows = [...body.data]
    .reverse()
    .map((d) => [
      fmtDate.format(dateToMs(d.date)),
      d.compra?.toFixed(4) ?? "n.d.",
      d.venta?.toFixed(4) ?? "n.d.",
    ]);
  renderTable("bcrp-table", ["Fecha", "Compra (S/)", "Venta (S/)"], rows);
  return true;
}

// ---------- Tarjetas y estado del mercado ----------
async function loadSummary() {
  const [health, bcrp, today] = await Promise.all([
    getJson("/api/health"),
    getJson("/api/bcrp/latest"),
    getJson("/api/live?range=1d"),
  ]);
  const live = health.last_live;
  const pill = $("market");
  const banner = $("banner");
  if (!health.market_open) {
    pill.dataset.state = "closed";
    $("market-text").textContent = "Mercado cerrado";
    banner.hidden = false;
    banner.dataset.kind = "closed";
    banner.textContent =
      "Mercado cerrado: el forex global no opera desde el viernes a las 16:00 hasta el domingo a las 16:00 (hora de Lima; 17:00 en Nueva York). Se muestra la última lectura disponible.";
  } else if (!health.lima_session_open) {
    pill.dataset.state = "off";
    $("market-text").textContent = "Fuera de horario en Lima";
    banner.hidden = false;
    banner.dataset.kind = "closed";
    banner.textContent =
      "Fuera del horario interbancario de Lima (lunes a viernes, 9:00–13:30). El forex global sigue abierto y las lecturas en vivo continúan.";
  } else {
    pill.dataset.state = "open";
    $("market-text").textContent = "Mercado abierto";
    banner.hidden = true;
  }

  $("c-live").textContent = pen(live?.price);
  $("c-live-at").textContent = live
    ? `Lectura de ${fmtFull.format(live.ts * 1000)}`
    : "Sin lecturas todavía";

  // Variación del día: contra la primera lectura válida del día en Lima.
  const startOfDay = Math.floor((Date.now() / 1000 + LIMA_OFFSET) / 86400) * 86400 - LIMA_OFFSET;
  const first = today.data.find((d) => d.ts >= startOfDay);
  const ch = $("c-change");
  ch.classList.remove("up", "down");
  if (live && first && live.ts >= startOfDay) {
    const diff = live.price - first.price;
    ch.textContent = signed(diff, (diff / first.price) * 100);
    if (diff !== 0) ch.classList.add(diff > 0 ? "up" : "down");
    $("c-change-hint").textContent =
      `Desde ${fmtTime.format(first.ts * 1000)} (primera lectura de hoy)`;
  } else {
    ch.textContent = "—";
    $("c-change-hint").textContent = "Sin lecturas hoy";
  }

  const b = bcrp.data;
  $("c-compra").textContent = pen(b?.compra, 3);
  $("c-venta").textContent = pen(b?.venta, 3);
  $("c-bcrp-date").textContent = b ? `Fecha: ${fmtDate.format(dateToMs(b.date))}` : "Sin datos";

  const d = $("c-diff");
  if (live && typeof b?.venta === "number") {
    const diff = live.price - b.venta;
    d.textContent = signed(diff, (diff / b.venta) * 100);
  } else d.textContent = "—";
}

async function refreshAll() {
  const guard = (fn, stateId) =>
    fn().catch((err) => {
      if (stateId) showState(stateId, "<strong>Error al mostrar los datos.</strong>", fn);
      throw err;
    });
  const results = await Promise.allSettled([
    loadSummary(),
    guard(loadLive, "live-state"),
    guard(loadBcrp, "bcrp-state"),
  ]);
  const failed = results.some((r) => r.status === "rejected" || r.value === false);
  const banner = $("banner");
  if (results[0].status === "rejected") {
    banner.hidden = false;
    banner.dataset.kind = "error";
    banner.textContent = "No se pudo actualizar el resumen. Se reintentará en 5 minutos.";
  }
  if (!failed) $("updated").textContent = `Última actualización: ${fmtTime.format(Date.now())}`;
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!document.hidden) void refreshAll();
  }, REFRESH_MS);
}

function bindControls() {
  for (const group of document.querySelectorAll(".seg")) {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn || btn.getAttribute("aria-pressed") === "true") return;
      for (const b of group.querySelectorAll("button"))
        b.setAttribute("aria-pressed", String(b === btn));
      if (group.dataset.target === "live") {
        state.liveRange = btn.dataset.range;
        void loadLive();
      } else {
        state.bcrpRange = btn.dataset.range;
        void loadBcrp();
      }
    });
  }
  $("outliers").addEventListener("change", (e) => {
    state.outliers = e.target.checked;
    void loadLive();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshAll();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    void loadLive();
    void loadBcrp();
  });
}

function start() {
  if (typeof Chart === "undefined") {
    showState("live-state", "<strong>No se pudo cargar la librería de gráficos.</strong>");
    showState("bcrp-state", "<strong>No se pudo cargar la librería de gráficos.</strong>");
    void loadSummary().catch(() => undefined);
    return;
  }
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  bindControls();
  void refreshAll();
  schedule();
}

document.addEventListener("DOMContentLoaded", start);
