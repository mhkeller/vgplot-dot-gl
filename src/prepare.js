/**
 * One pass over a query result. Works out everything the drawing needs that
 * doesn't depend on the plot's scales:
 *
 * - which rows can be drawn (x, y and radius are numbers, the category isn't null),
 * - the lowest and highest values, which Plot uses to set up the scales,
 * - a small integer per row for the fill category,
 * - the draw order (biggest dots first, like Plot's dot mark).
 *
 * The lowest and highest values come from every usable value in a column, not
 * only from drawable rows, because that is how Plot sets a scale from a column.
 * Columns arrive from mosaic as typed arrays when they can, and as plain arrays
 * when they have nulls or hold text or dates. Everything here takes both.
 */

/** Sort the same way Plot sorts a list of categories. */
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const BINS = 1024;

/** True when a column holds Date objects. The hints then stay Dates, so Plot picks a time scale. */
function holdsDates(column) {
  for (let i = 0; i < column.length; ++i) {
    const v = column[i];
    if (v != null) return v instanceof Date;
  }
  return false;
}

/** Number columns are split into this many colors. Codes 254 and 255 are not colors: 255 marks a hidden dot. */
export const CONTINUOUS_LEVELS = 254;

/**
 * @param {object} input
 * @param {ArrayLike<any>} input.x
 * @param {ArrayLike<any>} input.y
 * @param {ArrayLike<any>} [input.r]         radius column, or leave out for a fixed radius
 * @param {ArrayLike<any>} [input.fill]      category column (text), or with `continuous` a number column
 * @param {ArrayLike<any>} [input.fillCodes] category numbers already worked out in SQL (goes with `cats`)
 * @param {string[]} [input.cats]            the categories, sorted the way Plot sorts them, that `fillCodes` point into
 * @param {boolean} [input.continuous]       treat `fill` as numbers and split them into CONTINUOUS_LEVELS steps
 * @param {'-r'|null} [input.sort]           draw order: '-r' draws big dots first
 * @param {number} [input.maxCategories]     most categories allowed (the codes have to fit in one byte)
 * @param {boolean} [input.wantP25]          also pass along the 25th percentile of the radii, so Plot's
 *                                           default dot size range comes out the same as with all rows
 */
export function prepare({ x, y, r = null, fill = null, fillCodes = null, cats: givenCats = null, continuous = false, sort = '-r', maxCategories = 254, wantP25 = false }) {
  const total = x.length;
  const valid = new Uint8Array(total);
  const factorize = !!fill && !continuous;
  const temp = factorize ? new Uint16Array(total) : null;
  const seen = factorize ? new Map() : null;
  let fmin = Infinity, fmax = -Infinity;
  const xDates = holdsDates(x);
  const yDates = holdsDates(y);
  maxCategories = Math.min(254, maxCategories);

  let count = 0;
  let xmin = Infinity, xmax = -Infinity, xpos = Infinity;
  let ymin = Infinity, ymax = -Infinity, ypos = Infinity;
  let rmin = Infinity, rmax = -Infinity;

  for (let i = 0; i < total; ++i) {
    const xv = x[i];
    const yv = y[i];
    const xn = xv == null ? NaN : +xv;
    const yn = yv == null ? NaN : +yv;
    const xok = Number.isFinite(xn);
    const yok = Number.isFinite(yn);
    if (xok) {
      if (xn < xmin) xmin = xn;
      if (xn > xmax) xmax = xn;
      if (xn > 0 && xn < xpos) xpos = xn;
    }
    if (yok) {
      if (yn < ymin) ymin = yn;
      if (yn > ymax) ymax = yn;
      if (yn > 0 && yn < ypos) ypos = yn;
    }
    let rok = true;
    if (r) {
      const rv = r[i];
      const rn = rv == null ? NaN : +rv;
      rok = Number.isFinite(rn);
      if (rok) {
        if (rn < rmin) rmin = rn;
        if (rn > rmax) rmax = rn;
      }
    }
    if (!xok || !yok || !rok) continue;
    if (fillCodes) {
      const code = fillCodes[i];
      if (code == null || !(code >= 0 && code < givenCats.length)) continue;
    } else if (continuous) {
      const fv = fill[i];
      const fn = fv == null ? NaN : +fv;
      if (!Number.isFinite(fn)) continue;
      if (fn < fmin) fmin = fn;
      if (fn > fmax) fmax = fn;
    } else if (fill) {
      const fv = fill[i];
      if (fv == null) continue;
      let code = seen.get(fv);
      if (code === undefined) {
        code = seen.size;
        if (code >= maxCategories) {
          throw new Error(`dotGL: the fill column has more than ${maxCategories} distinct values`);
        }
        seen.set(fv, code);
      }
      temp[i] = code;
    }
    valid[i] = 1;
    ++count;
  }

  // Each category gets a number in Plot's sorted order, so category number i is also the i-th hint row.
  // Number columns get a step number over their range instead.
  const cats = givenCats ? givenCats : seen ? Array.from(seen.keys()).sort(ascending) : [];
  const codes = new Uint8Array(total).fill(255);
  if (fillCodes) {
    for (let i = 0; i < total; ++i) if (valid[i]) codes[i] = fillCodes[i];
  } else if (continuous) {
    const span = fmax - fmin;
    for (let i = 0; i < total; ++i) {
      if (!valid[i]) continue;
      codes[i] = span > 0 ? Math.min(CONTINUOUS_LEVELS - 1, Math.floor(((+fill[i] - fmin) / span) * CONTINUOUS_LEVELS)) : 0;
    }
  } else if (fill) {
    const remap = new Uint8Array(seen.size);
    cats.forEach((c, i) => { remap[seen.get(c)] = i; });
    for (let i = 0; i < total; ++i) if (valid[i]) codes[i] = remap[temp[i]];
  } else {
    for (let i = 0; i < total; ++i) if (valid[i]) codes[i] = 0;
  }

  // Radius histogram. It gives the draw order (a stable counting sort, biggest
  // first) and the 25th percentile of the positive radii, which Plot's default
  // dot size range depends on.
  const perm = new Uint32Array(count);
  let p25 = rmin;
  const histogram = r && rmax > rmin && (sort === '-r' || wantP25);
  if (histogram) {
    const scale = (BINS - 1) / (rmax - rmin);
    const bin = new Uint16Array(total);
    const counts = new Uint32Array(BINS + 1);
    const positive = new Uint32Array(BINS);
    let positives = 0;
    for (let i = 0; i < total; ++i) {
      const rv = r[i];
      const rn = rv == null ? NaN : +rv;
      if (!Number.isFinite(rn)) continue;
      const b = Math.round((rmax - rn) * scale); // 0 = largest radius
      if (rn > 0) { ++positive[b]; ++positives; }
      if (!valid[i]) continue;
      bin[i] = b;
      ++counts[b + 1];
    }
    let seenSoFar = 0;
    for (let b = BINS - 1; b >= 0; --b) {
      seenSoFar += positive[b];
      if (seenSoFar >= positives * 0.25) { p25 = Math.min(rmax, Math.max(rmin, rmax - b / scale)); break; }
    }
    if (sort === '-r') {
      for (let b = 0; b < BINS; ++b) counts[b + 1] += counts[b];
      for (let i = 0; i < total; ++i) if (valid[i]) perm[counts[bin[i]]++] = i;
    }
  }
  if (!histogram || sort !== '-r') {
    let k = 0;
    for (let i = 0; i < total; ++i) if (valid[i]) perm[k++] = i;
  }

  // Hints: short arrays, all of length k, that make Plot set up the same scales
  // it would from the full columns. For x and y the smallest positive value goes
  // first and the true minimum last: Plot's log scale looks at the first non-zero
  // value and then keeps only values with that sign, while a linear scale just
  // takes the lowest and highest. For r, the spare hint slots all hold the
  // 25th-percentile radius, because Plot reads that value to pick its default
  // dot size range.
  const needSlot = xmin <= 0 || ymin <= 0;
  const k = Math.max(2, cats.length, wantP25 && r ? 8 : 0, needSlot ? 3 : 0);
  const asDate = (flag, v) => (flag ? new Date(v) : v);
  const position = (min, max, pos, dates) => {
    // No usable value at all: pass `undefined`, which Plot treats like an empty column.
    if (!Number.isFinite(min)) return new Array(k).fill(undefined);
    const out = new Array(k).fill(asDate(dates, max));
    out[0] = asDate(dates, pos < Infinity ? pos : min);
    if (k > 2) out[k - 1] = asDate(dates, min);
    return out;
  };
  const radius = () => {
    if (!Number.isFinite(rmin)) return new Array(k).fill(undefined);
    const out = new Array(k).fill(wantP25 ? p25 : rmax);
    out[0] = rmin;
    out[1] = rmax;
    return out;
  };
  const hasFill = !!(fill || fillCodes);
  const hints = {
    x: position(xmin, xmax, xpos, xDates),
    y: position(ymin, ymax, ypos, yDates),
    r: r ? radius() : null,
    fill: !hasFill ? null
      : continuous ? position(fmin, fmax, Infinity, false)
      : Array.from({ length: k }, (_, i) => cats[Math.min(i, cats.length - 1)])
  };

  return {
    n: count,
    total,
    perm,
    codes,
    cats,
    continuous,
    levels: continuous ? CONTINUOUS_LEVELS : cats.length,
    hints,
    k,
    p25,
    extent: { x: [xmin, xmax], y: [ymin, ymax], r: r ? [rmin, rmax] : null, fill: continuous ? [fmin, fmax] : null, xpos, ypos }
  };
}
