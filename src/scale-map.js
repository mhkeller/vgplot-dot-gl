/**
 * Turns one of Observable Plot's scale objects (what `svg.scale('x')` returns,
 * and what a render function gets as `scales.scales.x`) into two parts:
 *
 * 1. `transformFor(scale)`: the curved part `T` (log, square root, power,
 *    symlog; nothing for linear and time scales). Applied once per value when
 *    the data is sent to the graphics card.
 * 2. `affine(scale, center, shift)`: the straight-line part, worked out again
 *    for every frame: `px = a * (T(v) - center) + b`. Panning and zooming only
 *    change `a` and `b`.
 *
 * Both depend only on the scale object, so the tests compare them with the d3
 * scales Plot builds from the same domain and range.
 *
 * A category axis (a point or band scale) is uploaded as category codes.
 * `categoryAxis` gives each code its place in the scale's domain and the straight
 * line through those places, `axisTransform` looks the places up, and `axisAffine`
 * picks between the two kinds of line.
 */

const identity = v => v;

/** Power that keeps the sign, like d3's pow and sqrt scales do for negative numbers. */
const power = e => v => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

/** The curved part of a scale, or a clear error for scale types the mark can't draw. */
export function transformFor(scale, name = 'position') {
  switch (scale?.type) {
    case undefined:
    case 'identity':
    case 'linear':
    case 'time':
    case 'utc':
      return identity;
    case 'point':
    case 'band':
      // The uploaded values are category codes; `categoryAxis` places them.
      return identity;
    case 'log':
      // The base only multiplies log values by a constant, and `affine` divides it out.
      return Math.log;
    case 'sqrt':
      return power(0.5);
    case 'pow':
      return power(scale.exponent ?? 1);
    case 'symlog': {
      const c = scale.constant ?? 1;
      return v => (v < 0 ? -Math.log1p(-v / c) : Math.log1p(v / c));
    }
    default:
      throw new Error(`dotGL: the ${name} scale type "${scale.type}" is not supported`);
  }
}

/**
 * The straight-line part. It takes a value that has been through `T` and had `center` subtracted, and gives the plot pixel.
 * `shift` moves the origin (for example to the top-left of the clip frame).
 */
export function affine(scale, center = 0, shift = 0, name = 'position') {
  if (!scale || scale.type === 'identity') return { a: 1, b: shift - center };
  const { domain, range } = scale;
  if (!domain || domain.length !== 2 || !range || range.length !== 2) {
    throw new Error(`dotGL: the ${name} scale must have a two-value domain and range`);
  }
  const T = transformFor(scale, name);
  const t0 = T(+domain[0]);
  const t1 = T(+domain[1]);
  const [r0, r1] = range;
  // When both ends of the domain are equal, d3 puts every value in the middle of the range.
  if (t1 === t0) return { a: 0, b: (r0 + r1) / 2 + shift };
  const a = (r1 - r0) / (t1 - t0);
  return { a, b: r0 + (center - t0) * a + shift };
}

/**
 * Where a point or band scale puts each category of a column drawn as category codes. `pos[code]` is the
 * category's place in the scale's domain, and place i is at pixel `a * i + b`, because these scales space
 * their domain evenly. A band scale's dots sit in the middle of the band. The domain is usually the
 * categories in the data, but it can list more (an explicit domain, `vg.Fixed`, or another mark on the
 * same axis) or leave some out; a category that isn't in the domain gets NaN and its dots aren't drawn,
 * as with Plot's dot. A number scale places no categories. Plot picks one when the only category left is
 * the empty value, and Plot's dot then draws nothing too.
 */
export function categoryAxis(scale, cats) {
  const pos = new Float64Array(cats.length).fill(NaN);
  if (scale.type !== 'point' && scale.type !== 'band') return { a: 0, b: 0, pos };
  // d3 keeps the first of repeated values in a domain, so places count distinct values.
  const place = new Map();
  for (const v of scale.domain) if (!place.has(v)) place.set(v, place.size);
  for (let i = 0; i < cats.length; ++i) pos[i] = place.get(cats[i]) ?? NaN;
  const values = Array.from(place.keys());
  const n = values.length;
  if (n === 0) return { a: 0, b: 0, pos };
  const first = scale.apply(values[0]);
  const a = n > 1 ? (scale.apply(values[n - 1]) - first) / (n - 1) : 0;
  return { a, b: first + (scale.bandwidth ?? 0) / 2, pos };
}

/**
 * The function the painters and the pick index run on an axis value before its line: the place lookup
 * for a category axis, the scale's curve otherwise. Codes past the end of the list (the hidden code) give NaN.
 */
export function axisTransform(scale, line, name = 'position') {
  if (!line) return transformFor(scale, name);
  const { pos } = line;
  return code => (code < pos.length ? pos[code] : NaN);
}

/** True when two category place tables are the same, or both absent. */
export function samePlaces(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * The per-frame line for an x or y axis, in the same form as `affine`: from the category axis when
 * the axis is drawn from category codes, otherwise from the scale.
 */
export function axisAffine(scale, line, center = 0, shift = 0, name = 'position') {
  return line ? { a: line.a, b: line.b + line.a * center + shift } : affine(scale, center, shift, name);
}

/** The pixel for one data value, worked out the same way the shader does it. */
export function project(scale, v, center = 0, shift = 0) {
  const { a, b } = affine(scale, center, shift);
  return a * (transformFor(scale)(+v) - center) + b;
}
