/** Helpers for the browser tests. Code inside page.evaluate runs in the demo page. */

export const DEMO = '/?rows=50000&seed=0.42&painter=gl';

/** Open the demo, wait for all the plots, and collect page errors. */
export async function openDemo(page, url = DEMO, { timeout = 120_000 } = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]', { timeout });
  return errors;
}

/** Stats of every panel's dot mark. */
export function panelStats(page) {
  return page.evaluate(() =>
    demo.panels().map(p => {
      const mark = p.plotEl.value.marks[0];
      return {
        stats: mark.stats,
        hasCanvas: !!p.plotEl.querySelector('svg foreignObject canvas'),
        legend: p.plotEl.querySelectorAll('.legend').length,
        title: p.spec.title
      };
    })
  );
}

/**
 * Take a sample of a panel's own rows, put them through the plot's scales, and
 * check that there is a painted pixel at each spot. This needs no SVG circles,
 * so it also works after a zoom.
 */
export function selfParity(page, panelIndex, samples = 600) {
  return page.evaluate(([index, samples]) => {
    const p = demo.panels()[index];
    const mark = p.plotEl.value.marks[0];
    const svg = p.plotEl.querySelector('svg');
    const xs = svg.scale('x');
    const ys = svg.scale('y');
    const fo = svg.querySelector('foreignObject');
    const canvas = fo.firstChild;
    const fx = +fo.getAttribute('x');
    const fy = +fo.getAttribute('y');
    const fw = +fo.getAttribute('width');
    const fh = +fo.getAttribute('height');
    const scale = canvas.width / fw;
    const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const cols = mark.data.columns;
    const X = cols[mark.channelField('x', { exact: true }).as];
    const Y = cols[mark.channelField('y', { exact: true }).as];
    const { codes, hidden } = mark.prep;
    const step = Math.max(1, Math.floor(X.length / samples));
    let tested = 0;
    let hit = 0;
    const misses = [];
    for (let i = 0; i < X.length && tested < samples; i += step) {
      if (codes[i] === hidden) continue;
      const cx = xs.apply(X[i]);
      const cy = ys.apply(Y[i]);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const px = Math.round((cx - fx) * scale);
      const py = Math.round((cy - fy) * scale);
      if (px < 1 || py < 1 || px >= canvas.width - 1 || py >= canvas.height - 1) continue;
      tested++;
      if (img[(py * canvas.width + px) * 4 + 3] > 0) hit++;
      else if (misses.length < 5) misses.push({ i, cx, cy, px, py });
    }
    return { tested, hit, misses, canvas: [canvas.width, canvas.height], frame: [fx, fy, fw, fh], scale };
  }, [panelIndex, samples]);
}

/** Which graphics driver the page ended up with (software ones make timings meaningless). */
export function glRenderer(page) {
  return page.evaluate(() => {
    const gl = demo.getSharedGL()?.gl;
    if (!gl) return 'none';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/** Wait until a panel has no query or redraw in flight and its mark has prepared data. */
export async function settle(page, panelIndex) {
  await page.waitForFunction(index => {
    const p = demo.panels()[index];
    const mark = p.plotEl.value.marks[0];
    return !p.plotEl.value.pendingRender && !!mark.prep && !!mark.stats;
  }, panelIndex, { timeout: 20_000 });
  await page.waitForTimeout(250);
}

/** Painted pixels of a panel's canvas. */
export function paintedPixels(page, panelIndex) {
  return page.evaluate(index => {
    const canvas = demo.panels()[index].plotEl.querySelector('foreignObject canvas');
    const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    return n;
  }, panelIndex);
}

/**
 * The dot under a screen point by the tooltip's rule, worked out one dot at a time from the plot's scales:
 * among the dots visible in the plot frame, the one drawn last that covers the point (as a circle, like the
 * 'gl' painter), else the one whose edge is closest, up to 40 px away. Returns its `row` and its center on
 * screen, or null.
 */
export function rowUnder(page, panelIndex, clientX, clientY) {
  return page.evaluate(([index, cx, cy]) => {
    const p = demo.panels()[index];
    const svg = p.plotEl.querySelector('svg');
    const ctm = svg.getScreenCTM();
    const u = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
    const xs = svg.scale('x'), ys = svg.scale('y'), rs = svg.scale('r');
    const fo = svg.querySelector('foreignObject');
    const [fx, fy, fw, fh] = ['x', 'y', 'width', 'height'].map(name => +fo.getAttribute(name));
    // The painters move dots half a pixel at pixel ratio 1, so they land on pixel centers.
    const offset = (window.devicePixelRatio || 1) > 1 ? 0 : 0.5;
    const x = u.x - fx, y = u.y - fy;
    if (!(x >= 0 && x <= fw && y >= 0 && y <= fh)) return null;
    const mark = p.plotEl.value.marks[0];
    const cols = mark.data.columns;
    const X = cols[mark.channelField('x', { exact: true }).as];
    const Y = cols[mark.channelField('y', { exact: true }).as];
    const rf = mark.channelField('r', { exact: true });
    const R = rf ? cols[rf.as] : null;
    const rConst = mark.constant('r') ?? 3;
    const { perm, codes, hidden, n } = mark.prep;
    let best = null;
    for (let i = 0; i < n; ++i) {
      const j = perm[i];
      if (codes[j] === hidden) continue;
      const px = xs.apply(X[j]) - fx + offset;
      const py = ys.apply(Y[j]) - fy + offset;
      const r = R ? rs.apply(R[j]) : rConst;
      if (!(r > 0 && px + r >= 0 && px - r <= fw && py + r >= 0 && py - r <= fh)) continue;
      const key = Math.max(0, Math.hypot(px - x, py - y) - r);
      if (key <= 40 && (!best || key <= best.key)) best = { j, key, px, py };
    }
    if (!best) return null;
    const pt = new DOMPoint(best.px + fx, best.py + fy).matrixTransform(ctm);
    return { row: best.j, x: pt.x, y: pt.y };
  }, [panelIndex, clientX, clientY]);
}

/** Screen position of the center of a panel's plot frame, and of one data row. */
export function plotGeometry(page, panelIndex, rowIndex) {
  return page.evaluate(([index, row]) => {
    const p = demo.panels()[index];
    const svg = p.plotEl.querySelector('svg');
    const ctm = svg.getScreenCTM();
    const xs = svg.scale('x');
    const ys = svg.scale('y');
    const [rx0, rx1] = [...xs.range].sort((a, b) => a - b);
    const [ry0, ry1] = [...ys.range].sort((a, b) => a - b);
    const toScreen = (x, y) => {
      const pt = new DOMPoint(x, y).matrixTransform(ctm);
      return { x: pt.x, y: pt.y };
    };
    const mark = p.plotEl.value.marks[0];
    const cols = mark.data.columns;
    const X = cols[mark.channelField('x', { exact: true }).as];
    const Y = cols[mark.channelField('y', { exact: true }).as];
    return {
      center: toScreen((rx0 + rx1) / 2, (ry0 + ry1) / 2),
      row: toScreen(xs.apply(X[row]), ys.apply(Y[row])),
      rowData: { x: X[row], y: Y[row] },
      xDomain: xs.domain,
      hostRect: (() => { const r = p.plotEl.getBoundingClientRect(); return { left: r.left, top: r.top }; })()
    };
  }, [panelIndex, rowIndex]);
}
