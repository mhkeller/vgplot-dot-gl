import { Mark } from '@uwdata/mosaic-plot';
import { toDataColumns } from '@uwdata/mosaic-core';
import { Query, cast, coalesce, epoch_ms, float64, isColumnRef, literal, verbatim } from '@uwdata/mosaic-sql';
import { prepare } from './prepare.js';
import { paletteFromValues, paletteFromScale, parseColor } from './color.js';
import { categoryLine } from './scale-map.js';
import { getSharedGL } from './shared-gl.js';
import { paintGL, freeGPU } from './painters/gl.js';
import { paintRect2D } from './painters/rect2d.js';
import { DotGLTip, KEY_AS } from './tip.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Options that are ours. They never become Mosaic channels or Plot options; the mark adds `key` and `orderby` to its query itself. */
const OWN_OPTIONS = ['painter', 'fallback', 'blit', 'sort', 'orderby', 'maxCategories', 'benchmark', 'fragmentBudget', 'key', 'tip'];

/** vg.dot options we accept as constants but can't draw. We warn once per mark. */
const IGNORED_OPTIONS = ['stroke', 'strokeWidth', 'strokeOpacity', 'symbol', 'rotate', 'dx', 'dy', 'title', 'href', 'select', 'frameAnchor'];

/** The only options that can be a column. */
const COLUMN_CHANNELS = ['x', 'y', 'r', 'fill'];

/** Most categories an x or y column may have. It is Plot's own limit for an axis whose categories it works out itself. */
const MAX_AXIS_CATEGORIES = 10000;

/** Most categories a fill column may have. Codes are 16 bits, and 65535 hides a dot. */
const MAX_FILL_CATEGORIES = 65535;

/**
 * The local Mosaic server turns away requests over 4 MiB, so the category lists in one query must stay under this.
 * Mosaic can combine the unfiltered queries of several plots on one table into one request, and their lists then add up.
 */
const MAX_CATEGORY_BYTES = 3.5 * 1024 * 1024;

/** Sort the same way Plot sorts the values of a category axis or legend: ascending, with null last. */
const ascendingDefined = (a, b) => (a == null) - (b == null) || (a < b ? -1 : a > b ? 1 : 0);

/** A number as a DOUBLE, with NaN for null, so the column arrives as a Float64Array. (`literal(NaN)` would print NULL.) */
const asDouble = e => coalesce(float64(e), verbatim("'NaN'::DOUBLE"));

/** How long you have to stop zooming before a lower-resolution frame is redrawn sharp. */
const REFINE_DELAY_MS = 150;

/**
 * SQL that gives each row the position of its value in `cats` (sorted, null last). Up to 254 categories
 * come back as UTINYINT with 255 for "hidden", more as USMALLINT with 65535. Values outside the list get the
 * hidden code. The column is cast to VARCHAR on both sides, because TRY_CAST from UUID or JSON straight to an
 * ENUM gives NULL for every row.
 */
function categorySQL(col, cats) {
  const small = cats.length <= 254;
  const hidden = small ? 255 : 65535;
  const nullCode = cats[cats.length - 1] === null ? cats.length - 1 : hidden;
  const values = cats.filter(v => v !== null).map(v => String(literal(v)));
  // DuckDB has no empty ENUM, so a column with no values besides null skips the lookup.
  const known = values.length ? `COALESCE(enum_code(TRY_CAST(CAST(${col} AS VARCHAR) AS ENUM(${values.join(', ')}))), ${hidden})` : hidden;
  return `CAST(CASE WHEN ${col} IS NULL THEN ${nullCode} ELSE ${known} END AS ${small ? 'UTINYINT' : 'USMALLINT'})`;
}

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
 * - orderby: what the query sorts rows by (a column name, `column()`, `desc()` or a `sql` fragment);
 *   rows are drawn in that order, later rows on top
 * - maxCategories: how many different fill values a database column may have (65,535 at most; array data allows 254)
 * - benchmark: true waits for the graphics card after each draw so the timings are real
 * - fragmentBudget: how much painting one frame may do before the mark draws at a
 *   lower resolution while you zoom and repaints sharp once you stop (default 4e7;
 *   Infinity turns it off)
 * - key: an expression for a unique row id, added to the query under a private name
 *   so the tooltip can look up more fields for one row
 * - tip: true, or `{ fields, maxRadius }`, shows a tooltip for the dot under the pointer;
 *   `fields` (an array of column names, or a Param holding one) are looked up by key
 *
 * The x, y and fill columns are handled by their database type. Number and date
 * columns come back as doubles (dates as epoch milliseconds). Text and boolean
 * columns are categories: the distinct values are fetched once per table, and the
 * query returns each row's position in the sorted list, which the graphics card
 * draws. Plot gets the list itself, so axes and legends show the text. A number or
 * date fill gets a color ramp: the values are split into 254 steps colored from
 * the plot's color scale, and Plot draws a ramp legend. Array data takes number
 * and date x and y, and up to 254 fill values.
 */
export class DotGLMark extends Mark {
  constructor(source, options = {}) {
    const own = {};
    const rest = {};
    for (const key in options) (OWN_OPTIONS.includes(key) ? own : rest)[key] = options[key];
    if (rest.fx != null || rest.fy != null) {
      throw new Error('dotGL: faceting (fx/fy) is not supported');
    }
    if (own.sort !== undefined && own.sort !== null && own.sort !== '-r') {
      throw new Error("dotGL: sort must be '-r' or null (use orderby to set the draw order)");
    }
    if (own.tip?.fields && own.key == null) throw new Error('dotGL: tip.fields needs a key column');
    super('dot', source, rest);
    if (own.tip?.fields && this.hasOwnData()) throw new Error('dotGL: tip.fields needs a database table');
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
    this.orderby = own.orderby ?? null;
    this.maxCategories = Math.min(MAX_FILL_CATEGORIES, own.maxCategories ?? MAX_FILL_CATEGORIES);
    this.benchmark = !!own.benchmark;
    this.fragmentBudget = own.fragmentBudget ?? 4e7;
    this.key = own.key ?? null;
    this.tip = own.tip ? (own.tip === true ? {} : own.tip) : null;
    /** Extra tooltip fields by key, filled in by the tooltip. */
    this.tipRows = new Map();
    this.refineTimer = null;
    this.lastPaint = null;
    this.prep = null;
    this.gpu = null;
    this.canvas = null;
    this.stats = null;
    this.destroyed = false;
    this.resultRef = null;
    /** Category columns by query alias: `{ cats, fragment }`. Channels on the same column share one entry. Filled in prepare(). */
    this.categories = new Map();
    this.render = this.render.bind(this);
  }

  /** Mosaic calls this when the mark joins a plot. With `tip` set, the mark brings its own tooltip interactor. */
  setPlot(plot, index) {
    super.setPlot(plot, index);
    if (this.tip) plot.addInteractor(new DotGLTip(this, this.tip));
  }

  /**
   * Runs once per table, before the first query. Mosaic looks up each column's
   * type. For text and boolean columns on x, y and fill this fetches the distinct
   * values and builds the SQL that turns each row into its category's position.
   */
  async prepare() {
    await super.prepare();
    // A new table or a changed field expression can change the rows behind each key.
    this.tipRows = new Map();
    // A result for the old query can still arrive while this waits. It is read with the old lists, which its
    // codes point into, so the new lists replace them only once they are complete.
    const categories = new Map();
    if (this.hasOwnData() || !this.coordinator || this.activePainter() === 'dot') {
      this.categories = categories;
      return;
    }

    // Channels on the same column share one alias. A shared column gets the smaller limit.
    // Mosaic reports an unnested column's list type, so unnested columns keep Mosaic's plain select.
    const wanted = new Map();
    for (const name of ['x', 'y', 'fill']) {
      const c = this.channelField(name, { exact: true });
      if (!c || this.isUnnested(c.field)) continue;
      if (c.type === 'array' || c.type === 'object') {
        throw new Error(`dotGL: the ${name} column "${isColumnRef(c.field) ? c.field.column : c.field}" has type ${c.sqlType}, which can't be drawn`);
      }
      if (c.type !== 'string' && c.type !== 'boolean') continue;
      if (!isColumnRef(c.field)) throw new Error(`dotGL: ${name} must be a plain column to be drawn as categories`);
      const limit = name === 'fill' ? this.maxCategories : MAX_AXIS_CATEGORIES;
      const entry = wanted.get(c.as);
      if (!entry) wanted.set(c.as, { c, name, limit });
      else if (limit < entry.limit) Object.assign(entry, { name, limit });
    }

    const entries = Array.from(wanted.values());
    const results = await Promise.all(entries.map(({ c, limit }) => this.coordinator.query(
      Query.from(this.sourceTable()).select({ v: cast(c.field, 'VARCHAR') }).distinct().limit(limit + 1)
    )));
    const encoder = new TextEncoder();
    let bytes = 0;
    let largest = null;
    entries.forEach(({ c, name, limit }, i) => {
      const col = c.field.column;
      const cats = Array.from(toDataColumns(results[i]).columns.v).sort(ascendingDefined);
      if (cats.length > limit) {
        throw new Error(`dotGL: the ${name} column "${col}" has more than ${limit} distinct values`);
      }
      const text = categorySQL(String(c.field), cats);
      const size = encoder.encode(JSON.stringify(text)).length;
      bytes += size;
      if (!largest || size > largest.size) largest = { col, size };
      categories.set(c.as, { cats, fragment: verbatim(text) });
    });
    if (bytes > MAX_CATEGORY_BYTES) {
      throw new Error(`dotGL: the categories of "${largest.col}" are too large to send (${(bytes / 1048576).toFixed(1)} MB)`);
    }
    this.categories = categories;
  }

  /**
   * The mark's data query. Column channels come back as numbers the painters can
   * use directly: category codes, doubles, or dates as epoch milliseconds. The key
   * comes back as it is, under a name Plot never sees.
   */
  query(filter) {
    const q = super.query(filter);
    if (!q) return q;
    if (this.orderby != null) q.orderby(this.orderby);
    if (this.key != null) q.select({ [KEY_AS]: this.key });
    if (this.activePainter() === 'dot') return q;
    for (const name of COLUMN_CHANNELS) {
      const c = this.channelField(name, { exact: true });
      if (!c || this.isUnnested(c.field)) continue;
      const category = this.categories.get(c.as);
      if (category) q.select({ [c.as]: category.fragment });
      else if (c.type === 'number') q.select({ [c.as]: asDouble(c.field) });
      else if (c.type === 'date') q.select({ [c.as]: asDouble(epoch_ms(c.field)) });
    }
    return q;
  }

  queryResult(data) {
    // A settled resize asks for the same query again and Mosaic's cache hands back the same table,
    // so the prepared rows and the GPU buffers still fit it.
    if (this.resultRef?.deref() === data) return this;
    this.resultRef = new WeakRef(data);
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
    const field = name => this.channelField(name, { exact: true });
    const column = name => (field(name) ? columns[field(name).as] : null);
    const cats = name => (field(name) ? this.categories.get(field(name).as)?.cats ?? null : null);
    const type = name => field(name)?.type;
    const x = column('x');
    const y = column('y');
    if (!x || !y) throw new Error('dotGL: x and y must be columns');
    const r = column('r');
    const fillCats = cats('fill');
    return prepare({
      x,
      y,
      r,
      fill: column('fill'),
      xCats: cats('x'),
      yCats: cats('y'),
      fillCats,
      continuous: !fillCats && (type('fill') === 'number' || type('fill') === 'date'),
      dates: { x: type('x') === 'date', y: type('y') === 'date', fill: type('fill') === 'date' },
      sort: this.sortMode,
      maxCategories: this.maxCategories,
      wantP25: !!r && this.plot?.getAttribute('rRange') == null
    });
  }

  plotSpecs() {
    if (!this.data || this.destroyed) return [];
    if (this.activePainter() === 'dot') {
      // SVG dots get Plot's own tooltip, which shows x, y, fill and r.
      const specs = super.plotSpecs();
      if (this.tip) specs[0].options.tip = true;
      return specs;
    }
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
    // A category axis places code i on the line through the pixels Plot gave hint row i. Number and date
    // values go through the scale's formula, and a point or band scale has none, so their dots would miss the ticks.
    const line = (name, scale, cats) => {
      if (cats) return categoryLine(scale, values[name], cats.length, name);
      if (scale.type === 'point' || scale.type === 'band') {
        throw new Error(`dotGL: the ${name} scale type "${scale.type}" is not supported for a number or date column`);
      }
      return null;
    };
    const lines = { x: line('x', sx, prep.xCats), y: line('y', sy, prep.yCats) };

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
    // Everything the tooltip needs to find the dots on screen again, and when they were painted.
    const params = { sx, sy, sr, lines, frame, style, prep, painter, labels: { x: scales.x?.label, y: scales.y?.label }, at: performance.now() };
    this.stats = painter === 'gl' ? paintGL(this, canvas, params, { allowReduce: true }) : paintRect2D(this, canvas, params);
    this.lastPaint = this.stats.skipped ? null : params;
    if (this.stats.reduced) this.refineTimer = setTimeout(() => this.refine(params), REFINE_DELAY_MS);

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
    this.lastPaint = null;
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
