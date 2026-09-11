import { Mark } from '@uwdata/mosaic-plot';
import { toDataColumns } from '@uwdata/mosaic-core';
import { Query, cond, eq, literal, isNotNull } from '@uwdata/mosaic-sql';
import { prepare } from './prepare.js';
import { paletteFromValues, paletteFromScale, parseColor } from './color.js';
import { getSharedGL } from './shared-gl.js';
import { paintGL, freeGPU } from './painters/gl.js';
import { paintRect2D } from './painters/rect2d.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Options that are ours. They must not end up in the SQL query or in Plot. */
const OWN_OPTIONS = ['painter', 'fallback', 'blit', 'sort', 'maxCategories', 'benchmark', 'fragmentBudget'];

/** vg.dot options we accept as constants but can't draw. We warn once per mark. */
const IGNORED_OPTIONS = ['stroke', 'strokeWidth', 'strokeOpacity', 'symbol', 'rotate', 'dx', 'dy', 'tip', 'title', 'href', 'select', 'frameAnchor'];

/** The only options that can be a column. */
const COLUMN_CHANNELS = ['x', 'y', 'r', 'fill'];

/** Sort the same way Plot sorts a list of categories. */
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** How long you have to stop zooming before a lower-resolution frame is redrawn sharp. */
const REFINE_DELAY_MS = 150;

/**
 * A dot mark that draws its points with WebGL instead of as SVG circles.
 *
 * It is a mosaic-plot Mark, so it gets the database query, the data decoding and
 * the option handling for free. Observable Plot still makes the axes, scales and
 * legend. Instead of the rows, the mark hands Plot a few numbers (the lowest and
 * highest values, the list of categories), and Plot works out the same scales
 * from those. The mark then draws the real rows into a canvas placed inside the
 * plot's SVG.
 *
 * Options are the ones vg.dot has for x, y, r, fill, opacity and clip, plus:
 * - painter: 'gl' (default), 'rect2d' (plain canvas), or 'dot' (the original SVG dots)
 * - fallback: what to use when the browser has no WebGL2 ('rect2d' default, or 'dot')
 * - blit: 'drawImage' (default) or 'bitmaprenderer', how the picture is copied into the plot
 * - sort: '-r' (default, big dots first when r is a column) or null
 * - maxCategories: how many different fill values are allowed (254 at most)
 * - benchmark: true waits for the graphics card after each draw so the timings are real
 * - fragmentBudget: how much painting one frame may do before the mark draws at a
 *   lower resolution while you zoom and repaints sharp once you stop (default 4e7;
 *   Infinity turns it off)
 *
 * A fill column is handled by its type. Text, dates and booleans are categories:
 * the distinct values are fetched once per table and the query returns small
 * integers instead of one string per row. A number column gets a color ramp: the values are split into 254 steps colored from the plot's color scale, and Plot draws a ramp legend.
 * into 254 steps colored from the plot's color scale, and Plot draws a ramp legend.
 */
export class DotGLMark extends Mark {
  constructor(source, options = {}) {
    const own = {};
    const rest = {};
    for (const key in options) (OWN_OPTIONS.includes(key) ? own : rest)[key] = options[key];
    if (rest.fx != null || rest.fy != null) {
      throw new Error('dotGL: faceting (fx/fy) is not supported');
    }
    super('dot', source, rest);
    for (const c of this.channels) {
      if (c.field && !COLUMN_CHANNELS.includes(c.channel)) {
        throw new Error(`dotGL: the "${c.channel}" option cannot be bound to a column (only x, y, r and fill can)`);
      }
    }
    const ignored = IGNORED_OPTIONS.filter(name => this.channel(name));
    if (ignored.length) console.warn(`dotGL: ignoring unsupported option(s) ${ignored.join(', ')}`);
    this.painter = own.painter ?? 'gl';
    this.fallback = own.fallback ?? 'rect2d';
    this.blit = own.blit ?? 'drawImage';
    this.sortMode = own.sort === undefined ? '-r' : own.sort;
    this.maxCategories = Math.min(254, own.maxCategories ?? 254);
    this.benchmark = !!own.benchmark;
    this.fragmentBudget = own.fragmentBudget ?? 4e7;
    this.refineTimer = null;
    this.lastPaint = null;
    this.prep = null;
    this.gpu = null;
    this.canvas = null;
    this.stats = null;
    this.destroyed = false;
    /** How the fill column arrives: 'none' | 'strings' | 'codes' | 'continuous'. Decided in prepare(). */
    this.fillMode = this.channelField('fill', { exact: true }) ? 'strings' : 'none';
    this.cats = null;
    this.codeExpr = null;
    this.render = this.render.bind(this);
  }

    /**
   * Runs once per table, before the first query. Finds out what kind of column
   * fill is. For categories it fetches the distinct values, so the data query
   * can send back integers instead of strings.
   */
  async prepare() {
    await super.prepare();
    const c = this.channelField('fill', { exact: true });
    this.cats = null;
    this.codeExpr = null;
    if (!c || this.painter === 'dot' || this.hasOwnData() || !this.coordinator) return;
    if (c.type === 'number') {
      this.fillMode = 'continuous';
      return;
    }
    const q = Query.from(this.sourceTable()).select({ v: c.field }).distinct().where(isNotNull(c.field));
    const { columns } = toDataColumns(await this.coordinator.query(q));
    const cats = Array.from(columns.v).sort(ascending);
    if (cats.length > this.maxCategories) {
      throw new Error(`dotGL: the fill column has ${cats.length} distinct values; at most ${this.maxCategories} are supported`);
    }
    let expr = cond();
    cats.forEach((v, i) => { expr = expr.when(eq(c.field, literal(v)), i); });
    this.cats = cats;
    this.codeExpr = expr;
    this.fillMode = 'codes';
  }

  /** The mark's data query. With categories, the fill column is swapped for a CASE expression that returns the code. */
  query(filter) {
    const q = super.query(filter);
    if (q && this.codeExpr) {
      const { as } = this.channelField('fill', { exact: true });
      q.select({ [as]: this.codeExpr });
    }
    return q;
  }

  queryResult(data) {
    super.queryResult(data);
    clearTimeout(this.refineTimer);
    this.lastPaint = null;
    this.prep = null;
    return this;
  }

  /** The value of a constant option such as r: 2.5 or opacity: 0.6. */
  constant(name) {
    const c = this.channel(name);
    return c && Object.hasOwn(c, 'value') ? c.value : undefined;
  }

  /** Which painter draws this time: 'gl', 'rect2d' or 'dot'. */
  activePainter() {
    if (this.painter === 'gl' && getSharedGL(this.blit)) return 'gl';
    if (this.painter === 'gl') return this.fallback;
    return this.painter;
  }

  prepareData() {
    const columns = this.data?.columns;
    if (!columns) throw new Error('dotGL: expected columnar data');
    const column = name => {
      const f = this.channelField(name, { exact: true });
      return f ? columns[f.as] : null;
    };
    const x = column('x');
    const y = column('y');
    if (!x || !y) throw new Error('dotGL: x and y must be columns');
    const r = column('r');
    const fill = column('fill');
    const mode = this.fillMode;
    return prepare({
      x,
      y,
      r,
      fill: mode === 'codes' ? null : fill,
      fillCodes: mode === 'codes' ? fill : null,
      cats: mode === 'codes' ? this.cats : null,
      continuous: mode === 'continuous',
      sort: this.sortMode,
      maxCategories: this.maxCategories,
      wantP25: !!r && this.plot?.getAttribute('rRange') == null
    });
  }

  plotSpecs() {
    if (!this.data || this.destroyed) return [];
    if (this.activePainter() === 'dot') return super.plotSpecs();
    const prep = (this.prep ??= this.prepareData());
    const options = { sort: null, render: this.render };
    for (const c of this.channels) {
      if (Object.hasOwn(c, 'value')) {
        options[c.channel] = c.value;
        continue;
      }
      switch (c.channel) {
        case 'x':
        case 'y':
        case 'r':
          options[c.channel] = prep.hints[c.channel];
          break;
        case 'fill':
          options.fill = { value: prep.hints.fill, scale: 'color' };
          break;
        default:
          throw new Error(`dotGL: the "${c.channel}" option cannot be bound to a column`);
      }
    }
    return [{ type: 'dot', data: { length: prep.k }, options }];
  }

    /**
   * Observable Plot calls this once per redraw and passes its scales. The points
   * are drawn into a canvas that we keep between redraws and move into each new
   * SVG, inside a foreignObject the size of the plot frame (or the whole plot when clip is off).
   */
  render(index, scales, values, dimensions, context) {
    const doc = context.document;
    const g = doc.createElementNS(SVG, 'g');
    g.setAttribute('aria-label', 'dot');
    const prep = this.prep;
    if (this.destroyed || !prep || prep.n === 0) return g;

    const sx = scales.scales.x;
    const sy = scales.scales.y;
    // Only our own radius column uses the r scale. Another mark in the plot may have made one.
    const sr = this.channelField('r', { exact: true }) ? scales.scales.r : undefined;
    if (!sx || !sy) throw new Error('dotGL: the plot must have x and y scales (projections are not supported)');

    const { width: W, height: H, marginLeft: ml, marginTop: mt, marginRight: mr, marginBottom: mb } = dimensions;
    const clip = !!this.constant('clip');
    const [fx, fy, fw, fh] = clip ? [ml, mt, W - ml - mr, H - mt - mb] : [0, 0, W, H];
    const dpr = globalThis.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(fw * dpr));
    const ph = Math.max(1, Math.round(fh * dpr));
    const frame = { fx, fy, fw, fh, pw, ph, dpr, offset: dpr > 1 ? 0 : 0.5 };

    const canvas = (this.canvas ??= doc.createElement('canvas'));
    // The painters set the canvas size; the WebGL painter may pick a lower resolution.
    canvas.style.cssText = `display:block;width:${fw}px;height:${fh}px;pointer-events:none`;

    // Plot's dot would draw hollow rings in the text color. This mark always fills.
    const fill = this.constant('fill') ?? 'currentColor';
    const style = {
      opacity: +(this.constant('opacity') ?? 1) * +(this.constant('fillOpacity') ?? 1),
      fill,
      fillRGBA: parseColor(fill, this.plot?.element),
      r: +(this.constant('r') ?? 3),
      palette: !values.fill ? null
        : prep.continuous ? paletteFromScale(scales.scales.color, prep.extent.fill, prep.levels)
        : paletteFromValues(values.fill, prep.cats.length)
    };

    clearTimeout(this.refineTimer);
    const painter = this.activePainter();
    const params = { sx, sy, sr, frame, style, prep };
    if (painter === 'gl') {
      this.stats = paintGL(this, canvas, params, { allowReduce: true });
      if (this.stats.reduced) {
        this.lastPaint = params;
        this.refineTimer = setTimeout(() => this.refine(params), REFINE_DELAY_MS);
      }
    } else {
      this.stats = paintRect2D(this, canvas, params);
    }

    const fo = doc.createElementNS(SVG, 'foreignObject');
    fo.setAttribute('x', fx);
    fo.setAttribute('y', fy);
    fo.setAttribute('width', fw);
    fo.setAttribute('height', fh);
    fo.style.pointerEvents = 'none';
    fo.appendChild(canvas);
    g.appendChild(fo);
    return g;
  }

  /** Redraw the last frame sharp once zooming has stopped. */
  refine(params) {
    if (this.destroyed || this.lastPaint !== params || this.prep !== params.prep || !this.canvas) return;
    this.stats = { ...paintGL(this, this.canvas, params), refined: true };
    // Tell the page the sharp frame is on screen (the demo shows its timings).
    this.plot?.element?.dispatchEvent(new CustomEvent('dotgl-refine', { detail: { mark: this, stats: this.stats } }));
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.refineTimer);
    super.destroy?.();
    freeGPU(this);
    if (this.canvas) {
      this.canvas.remove();
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
    }
    this.prep = null;
    this.data = null;
  }
}

/** Use inside vg.plot() in place of vg.dot. */
export const dotGL = (source, options) => plot => plot.addMark(new DotGLMark(source, options));
