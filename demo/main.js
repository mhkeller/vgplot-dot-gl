import { wasmConnector } from '@uwdata/mosaic-core';
import { Plot } from '@uwdata/mosaic-plot';
import * as vg from '@uwdata/vgplot';
import { dotGL } from '../src/index.js';
import { getSharedGL, disposeSharedGL } from '../src/shared-gl.js';
import { buildPickIndex, pickDot } from '../src/pick.js';

const PARTY_COLORS = { D: '#2166ac', R: '#b2182b', I: '#4d9221', G: '#e08214' };
const POINT_COLOR = '#4a6fa5';

// ?rows=50000&seed=0.42 makes a run repeatable (the seed fixes DuckDB's random()).
const params = new URLSearchParams(location.search);
const seed = params.has('seed') ? Number(params.get('seed')) : null;

const ui = {
  rows: document.getElementById('rows'),
  benchmark: document.getElementById('benchmark'),
  status: document.getElementById('status'),
  grid: document.getElementById('grid'),
  ab: document.getElementById('ab')
};

// Time every mosaic redraw so each panel can show it.
const originalRender = Plot.prototype.render;
Plot.prototype.render = async function () {
  const t = performance.now();
  await originalRender.call(this);
  this.element.dispatchEvent(new CustomEvent('rendered', { detail: { ms: performance.now() - t } }));
};

const coord = vg.coordinator();
coord.databaseConnector(wasmConnector());
const exec = sql => coord.exec(sql);
const query = sql => coord.query(sql, { type: 'json' });

async function loadData(n) {
  ui.status.textContent = `creating ${n.toLocaleString()} rows…`;
  const t = performance.now();
  if (seed != null) await exec(`SELECT setseed(${seed})`);
  await exec(`CREATE OR REPLACE TABLE pts AS
    SELECT
      exp(random() * 9) + 1 AS size,
      (exp(random() * 9) + 1) * (0.4 + random() * 1.2) AS price,
      power(random(), 2) * 100 AS volume,
      random() * 2 - 1 AS shift,
      ['D', 'R', 'I', 'G'][1 + floor(random() * 4)::INT] AS party,
      DATE '2020-01-01' + (random() * 1800)::INT AS day,
      TIMESTAMP '2020-01-01' + to_seconds((random() * 1800 * 86400)::BIGINT) AS ts,
      TIME '00:00:00' + to_seconds((random() * 86400)::BIGINT) AS tod,
      row_number() OVER () AS id
    FROM range(${n})`);
  // The marks' SQL text hasn't changed, so mosaic's query cache would hand back the old rows.
  coord.clear({ clients: false, cache: true });
  ui.status.textContent = `${n.toLocaleString()} rows ready in ${Math.round(performance.now() - t)} ms`;
}

/** The demo panels. Their options copy the scatter plots in the app this mark was built for. */
const PANELS = [
  { title: 'size vs price · log-log · party · r 2.5', x: 'size', y: 'price', fill: 'party', log: true },
  { title: 'size vs price · linear · party · r volume', x: 'size', y: 'price', fill: 'party', size: 'volume' },
  { title: 'price vs volume · constant color', x: 'price', y: 'volume', log: false },
  { title: 'size vs price · log-log · party · r volume', x: 'size', y: 'price', fill: 'party', size: 'volume', log: true },
  { title: 'volume vs shift · brush filters the next panel', x: 'volume', y: 'shift', fill: 'party', brush: true },
  { title: 'size vs price · filtered by the brush', x: 'size', y: 'price', fill: 'party', log: true, filtered: true },
  { title: 'price vs volume · continuous color by shift', x: 'price', y: 'volume', fill: 'shift', scheme: 'viridis' },
  // The three date types. `tod` on r checks a date-typed radius, which the tooltip used to print as a raw number.
  { title: 'day vs price · DATE on x · TIME on r', x: 'day', y: 'price', fill: 'party', size: 'tod', sizeIsDate: true },
  { title: 'ts vs volume · TIMESTAMP on x · DATE as color', x: 'ts', y: 'volume', fill: 'day', scheme: 'viridis' }
];

let brush = null;
let panels = [];

async function buildPanel(spec, { benchmark }) {
  const view = 'pts';
  const marks = [];
  const colored = !!spec.fill;
  const sized = !!spec.size;
  const filterBy = spec.filtered ? brush : undefined;

  let rDomain = null;
  if (sized) {
    // A date or time column's quantile is itself a date, so take it as the milliseconds the mark draws with.
    const q = p => (spec.sizeIsDate ? `epoch_ms(quantile_cont("${spec.size}", ${p}))` : `quantile_cont("${spec.size}", ${p})`);
    const [s] = await query(`SELECT ${q(0.05)} AS lo, ${q(0.95)} AS hi FROM ${view}`);
    if (s && s.hi > s.lo) rDomain = [s.lo, s.hi];
  }

  const xZoom = new vg.Selection();
  const yZoom = new vg.Selection();
  marks.push(
    dotGL(vg.from(view, { filterBy }), {
      x: spec.x,
      y: spec.y,
      ...(sized ? { r: spec.size } : { r: 2.5 }),
      opacity: 0.6,
      clip: true,
      fill: colored ? spec.fill : POINT_COLOR,
      key: vg.int32('id'),
      tip: { fields: ['id', 'party', 'day', 'ts', 'tod'] },
      benchmark
    })
  );
  if (sized) {
    marks.push(vg.rRange([2, 11]));
    if (rDomain) marks.push(vg.rDomain(rDomain));
  }
  if (spec.fill === 'party') {
    const keys = Object.keys(PARTY_COLORS);
    marks.push(vg.colorDomain(keys), vg.colorRange(keys.map(k => PARTY_COLORS[k])), vg.colorLegend({ columns: 1 }));
  } else if (colored) {
    marks.push(vg.colorScheme(spec.scheme), vg.colorLegend());
  }
  marks.push(
    vg.width(430),
    vg.height(330),
    vg.marginLeft(spec.log ? 64 : 58),
    vg.xLabel(spec.x),
    vg.yLabel(spec.y)
  );
  // A brush catches every drag, and d3-brush swallows the mouse-up that d3-zoom
  // waits for, which leaves the pan stuck on. One or the other per plot.
  if (spec.brush) marks.push(vg.intervalXY({ as: brush, brush: { fill: 'none', stroke: '#333' } }));
  else marks.push(vg.panZoom({ x: xZoom, y: yZoom, xfield: spec.x, yfield: spec.y }));
  if (spec.log) marks.push(vg.xScale('log'), vg.yScale('log'));
  return vg.plot(...marks);
}

function makePanelHost(spec) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h3><span>${spec.title}</span></h3><div class="stats">…</div><div class="host"></div>`;
  return { panel, mount: panel.querySelector('.host'), stats: panel.querySelector('.stats') };
}

function describeStats(plotEl, ms) {
  const plot = plotEl.value;
  const mark = plot.marks.find(m => m.stats !== undefined);
  const s = mark?.stats;
  const parts = [Number.isFinite(ms) ? `render ${ms.toFixed(1)} ms` : 'refined after idle'];
  if (s?.skipped) parts.push(s.skipped);
  else if (s?.painter === 'gl') parts.push(`upload ${s.uploadMs.toFixed(1)} · draw ${s.drawMs.toFixed(1)} · blit ${s.blitMs.toFixed(1)} · ${s.drawn.toLocaleString()} dots · dpr ${s.dpr.toFixed(2)}${s.reduced ? ' (reduced)' : ''}${s.refined ? ' (refined)' : ''} · ~${(s.estimate / 1e6).toFixed(0)}M frags`);
  else if (s?.painter === 'rect2d') parts.push(`canvas draw ${s.drawMs.toFixed(1)} · ${s.drawn.toLocaleString()} dots`);
  else parts.push(`${plotEl.querySelectorAll('circle').length.toLocaleString()} svg circles`);
  return parts.join('\n');
}

/**
 * Resolves once a plot has drawn with data. (mosaic's synchronizer promise is
 * replaced after each redraw, so waiting on it afterwards never finishes.)
 */
function firstRender(plotEl) {
  const mark = plotEl.value.marks.find(m => 'stats' in m);
  if (mark?.stats) return Promise.resolve();
  return new Promise(resolve => plotEl.addEventListener('rendered', () => resolve(), { once: true }));
}

function disposePanels(list) {
  for (const p of list) {
    p.plotEl?.value?.marks?.forEach(m => m.destroy?.());
    p.host.panel.remove();
  }
}

async function rebuild() {
  delete document.body.dataset.ready;
  const rows = +ui.rows.value;
  const benchmark = ui.benchmark.checked;
  disposePanels(panels);
  panels = [];
  brush = vg.Selection.crossfilter();
  await loadData(rows);
  const t0 = performance.now();
  for (const spec of PANELS) {
    const host = makePanelHost(spec);
    ui.grid.append(host.panel);
    const plotEl = await buildPanel(spec, { benchmark });
    plotEl.addEventListener('rendered', e => { host.stats.textContent = describeStats(plotEl, e.detail.ms); });
    plotEl.addEventListener('dotgl-refine', () => { host.stats.textContent = describeStats(plotEl, NaN); });
    host.mount.replaceChildren(plotEl);
    panels.push({ spec, host, plotEl });
  }
  await Promise.all(panels.map(p => firstRender(p.plotEl)));
  const gl = getSharedGL();
  ui.status.textContent = `${rows.toLocaleString()} rows · ${panels.length} plots ready in ${Math.round(performance.now() - t0)} ms` + (gl ? ` · shared GL ${gl.width}×${gl.height}` : ' · no WebGL2');
  document.body.dataset.ready = '1';
}

/** Wheel-zoom the first panel for two seconds and count redraws. */
async function zoomTest() {
  const target = panels[0]?.plotEl;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width * 0.55;
  const clientY = rect.top + rect.height * 0.45;
  let renders = 0;
  const count = () => renders++;
  target.addEventListener('rendered', count);
  const start = performance.now();
  let dir = -1;
  let ticks = 0;
  await new Promise(resolve => {
    const step = () => {
      const now = performance.now();
      if (now - start >= 2000) return resolve();
      if (++ticks % 40 === 0) dir = -dir;
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 12, clientX, clientY, bubbles: true, cancelable: true }));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await new Promise(r => setTimeout(r, 100));
  target.removeEventListener('rendered', count);
  const seconds = (performance.now() - start) / 1000;
  ui.status.textContent = `zoom test: ${renders} renders in ${seconds.toFixed(1)} s = ${(renders / seconds).toFixed(1)} fps (${ticks} wheel events)`;
}

/** Side by side: the original SVG dot mark and dotGL on the same 50k-row view. */
async function compare() {
  ui.ab.replaceChildren();
  delete ui.ab.dataset.ready;
  await exec('CREATE OR REPLACE VIEW pts50 AS SELECT * FROM pts ORDER BY id LIMIT 50000');
  const [s] = await query('SELECT quantile_cont(volume, 0.05) AS lo, quantile_cont(volume, 0.95) AS hi FROM pts50');
  for (const kind of ['dot', 'gl']) {
    const host = makePanelHost({ title: `A/B · ${kind === 'dot' ? 'SVG circles (vg.dot)' : 'dotGL'} · 50k rows` });
    ui.ab.append(host.panel);
    const keys = Object.keys(PARTY_COLORS);
    const mark = kind === 'dot' ? vg.dot : dotGL;
    const plotEl = vg.plot(
      mark(vg.from('pts50'), { x: 'size', y: 'price', r: 'volume', fill: 'party', opacity: 0.6, clip: true }),
      vg.rRange([2, 11]), vg.rDomain([s.lo, s.hi]),
      vg.colorDomain(keys), vg.colorRange(keys.map(k => PARTY_COLORS[k])), vg.colorLegend({ columns: 1 }),
      vg.xScale('log'), vg.yScale('log'), vg.width(430), vg.height(330), vg.marginLeft(64),
      vg.xLabel('size'), vg.yLabel('price')
    );
    plotEl.addEventListener('rendered', e => { host.stats.textContent = describeStats(plotEl, e.detail.ms); });
    host.mount.replaceChildren(plotEl);
    await firstRender(plotEl);
  }
  ui.ab.dataset.ready = '1';
}

document.getElementById('rebuild').addEventListener('click', () => rebuild());
document.getElementById('zoomtest').addEventListener('click', () => zoomTest());
document.getElementById('compare').addEventListener('click', () => compare());
ui.rows.addEventListener('change', () => rebuild());

window.demo = { rebuild, zoomTest, compare, panels: () => panels, vg, getSharedGL, disposeSharedGL, dotGL, buildPickIndex, pickDot };
if (params.has('rows')) {
  const rows = params.get('rows');
  if (![...ui.rows.options].some(o => o.value === rows)) ui.rows.add(new Option(rows, rows));
  ui.rows.value = rows;
}
if (params.get('benchmark') === '1') ui.benchmark.checked = true;
rebuild().then(() => { document.body.dataset.ready = '1'; }).catch(err => { ui.status.textContent = `error: ${err.message}`; console.error(err); });
