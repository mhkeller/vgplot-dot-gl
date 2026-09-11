/**
 * A small copy of the hover handling from the app this mark was built for. The database, not the drawing,
 * answers "which row is under the mouse". It reads the scales off the Plot SVG
 * and uses the SVG's `getScreenCTM()` to place a ring on the page, so it works the same whether
 * the dots are SVG circles or a canvas.
 *
 * "Under the mouse" takes dot size into account: a dot whose circle covers the
 * mouse beats a dot whose center happens to be closer, and among covering dots
 * the smallest wins, because the mark draws big dots first and small ones on top.
 * The radius is worked out in SQL from the plot's r scale, so the query sees the
 * same pixel sizes the drawing used.
 */
const RADIUS = 14;
const THROTTLE_MS = 120;

export function hoverProbe({ view, x, y, r, columns, query, onHover }) {
  return plot => plot.addInteractor(new HoverProbe(plot, { view, x, y, r, columns, query, onHover }));
}

/** SQL for a dot's radius in pixels: a fixed number, or the plot's r scale applied to a column. */
function radiusSQL(r, scale) {
  if (r == null) return '3';
  if (typeof r === 'number') return String(r);
  if (!scale) return '3';
  const [d0, d1] = scale.domain;
  const [r0, r1] = scale.range;
  const col = `"${r}"`;
  const T = v => {
    switch (scale.type) {
      case 'sqrt': return `sqrt(greatest(${v}, 0))`;
      case 'log': return `ln(${v})`;
      case 'pow': return `power(${v}, ${scale.exponent ?? 1})`;
      default: return `(${v})`;
    }
  };
  const t0 = T(d0), t1 = T(d1);
  return `(${r0} + (${T(col)} - ${t0}) / (${t1} - ${t0}) * ${r1 - r0})`;
}

class HoverProbe {
  constructor(plot, opts) {
    this.plot = plot;
    this.opts = opts;
    this.token = 0;
    this.last = 0;
    this.listening = false;
  }

  init() {
    // Every redraw (a zoom step, a filter change) moves the dots, so the ring and
    // tip go away. The next time the mouse settles we ask again.
    this.clear();
    if (this.listening) return;
    this.listening = true;
    const el = this.plot.element;
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.clear);
    // Capture phase, because d3-zoom stops wheel events before normal listeners see them.
    el.addEventListener('wheel', this.clear, { passive: true, capture: true });
  }

  onMove = event => {
    if (event.buttons) return this.clear();
    const now = performance.now();
    const wait = Math.max(0, THROTTLE_MS - (now - this.last));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.last = performance.now();
      void this.probe(event.clientX, event.clientY);
    }, wait);
  };

  async probe(clientX, clientY) {
    const svg = this.plot.element.firstElementChild;
    const xs = svg?.scale?.('x');
    const ys = svg?.scale?.('y');
    if (!xs || !ys) return;
    const toScreen = svg.getScreenCTM();
    if (!toScreen) return;
    const cursor = new DOMPoint(clientX, clientY).matrixTransform(toScreen.inverse());
    const [rx0, rx1] = [...xs.range].sort((a, b) => a - b);
    const [ry0, ry1] = [...ys.range].sort((a, b) => a - b);
    if (cursor.x < rx0 || cursor.x > rx1 || cursor.y < ry0 || cursor.y > ry1) return this.clear();
    const dataX = xs.invert(cursor.x);
    const dataY = ys.invert(cursor.y);
    const dx = Math.abs(xs.invert(cursor.x + RADIUS) - dataX);
    const dy = Math.abs(ys.invert(cursor.y + RADIUS) - dataY);
    if (!(dx > 0) || !(dy > 0)) return;
    const { view, x, y, r, columns } = this.opts;
    const select = [...new Set([...columns, x, y])].map(c => `"${c}"`).join(', ');
    const rs = svg.scale('r');
    // Search area: the hover radius plus the biggest dot, so a big dot whose center
    // is farther away than RADIUS but still covers the mouse is a candidate.
    const rmax = typeof r === 'number' ? r : rs ? Math.max(...rs.range) : 3;
    const reach = (RADIUS + rmax) / RADIUS;
    // Distance from the mouse in pixels (dx and dy are RADIUS pixels in data units).
    const distPx = `${RADIUS} * sqrt(POWER(("${x}" - ${dataX}) / ${dx}, 2) + POWER(("${y}" - ${dataY}) / ${dy}, 2))`;
    const radiusPx = radiusSQL(r, rs);
    // Covering dots first; among them the smallest (it is drawn on top). A fixed
    // radius needs no tie-break, and SQL would read a bare number in ORDER BY as a column position, not as a value.
    const order = typeof r === 'number' || rs == null
      ? `greatest(0, ${distPx} - ${radiusPx})`
      : `greatest(0, ${distPx} - ${radiusPx}) ASC, ${radiusPx} ASC`;
    const sql = `SELECT ${select} FROM "${view}"
      WHERE "${x}" BETWEEN ${dataX - dx * reach} AND ${dataX + dx * reach} AND "${y}" BETWEEN ${dataY - dy * reach} AND ${dataY + dy * reach}
      ORDER BY ${order} LIMIT 1`;
    const mine = ++this.token;
    let rows;
    try {
      rows = await this.opts.query(sql);
    } catch {
      return;
    }
    if (mine !== this.token) return;
    const row = rows[0];
    if (!row) return this.clear();
    const at = new DOMPoint(xs.apply(Number(row[x])), ys.apply(Number(row[y]))).matrixTransform(toScreen);
    const host = this.plot.element.getBoundingClientRect();
    this.opts.onHover({ row, left: at.x - host.left, top: at.y - host.top });
  }

  clear = () => {
    clearTimeout(this.timer);
    this.token++;
    this.opts.onHover(null);
  };
}
