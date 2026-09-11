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

/** The pixel for one data value, worked out the same way the shader does it. */
export function project(scale, v, center = 0, shift = 0) {
  const { a, b } = affine(scale, center, shift);
  return a * (transformFor(scale)(+v) - center) + b;
}
