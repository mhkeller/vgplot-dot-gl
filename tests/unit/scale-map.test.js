// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { scaleLinear, scaleLog, scaleSqrt, scalePow, scaleSymlog } from 'd3-scale';
import * as Plot from '@observablehq/plot';
import { transformFor, affine, axisAffine, categoryLine, project } from '../../src/scale-map.js';

const cases = [
  { name: 'linear', desc: { type: 'linear', domain: [10, 250], range: [40, 600] }, d3: () => scaleLinear() },
  { name: 'linear reversed (y)', desc: { type: 'linear', domain: [-5, 5], range: [400, 20] }, d3: () => scaleLinear() },
  { name: 'log', desc: { type: 'log', domain: [1, 1e5], range: [40, 600], base: 10 }, d3: () => scaleLog() },
  { name: 'sqrt', desc: { type: 'sqrt', domain: [0, 100], range: [2, 11] }, d3: () => scaleSqrt() },
  { name: 'pow', desc: { type: 'pow', domain: [0, 100], range: [0, 300], exponent: 2 }, d3: () => scalePow().exponent(2) },
  { name: 'symlog', desc: { type: 'symlog', domain: [-100, 100], range: [0, 500], constant: 1 }, d3: () => scaleSymlog().constant(1) }
];

describe('scale-map matches d3', () => {
  for (const { name, desc, d3 } of cases) {
    it(name, () => {
      const s = d3().domain(desc.domain).range(desc.range);
      const [d0, d1] = desc.domain;
      const T = transformFor(desc);
      const center = (T(d0) + T(d1)) / 2;
      for (let i = 0; i <= 20; ++i) {
        const v = desc.type === 'log' ? Math.exp(Math.log(d0) + (i / 20) * (Math.log(d1) - Math.log(d0))) : d0 + (i / 20) * (d1 - d0) * 1.5 - 0.25 * (d1 - d0);
        if (desc.type === 'log' && v <= 0) continue;
        const expected = s(v);
        expect(project(desc, v)).toBeCloseTo(expected, 8);
        // Centering must not change the result.
        const { a, b } = affine(desc, center, 0);
        expect(a * (T(v) - center) + b).toBeCloseTo(expected, 8);
      }
    });
  }

  it('applies an origin shift', () => {
    const desc = { type: 'linear', domain: [0, 10], range: [40, 240] };
    expect(project(desc, 5, 0, -40)).toBeCloseTo(100, 10);
  });

  it('treats identity and time scales as linear in the numeric value', () => {
    expect(transformFor({ type: 'identity' })(3)).toBe(3);
    expect(transformFor({ type: 'utc' })(3)).toBe(3);
    const desc = { type: 'utc', domain: [new Date(0), new Date(1000)], range: [0, 100] };
    expect(project(desc, new Date(250))).toBeCloseTo(25, 10);
  });

  it('rejects scale types the shader cannot draw', () => {
    expect(() => transformFor({ type: 'threshold' }, 'x')).toThrow(/threshold/);
    expect(() => affine({ type: 'linear', domain: [0, 1, 2], range: [0, 1] })).toThrow(/two-value/);
  });

  it('uploads point and band values (category codes) unchanged', () => {
    expect(transformFor({ type: 'point' })(7)).toBe(7);
    expect(transformFor({ type: 'band' })(7)).toBe(7);
  });
});

describe('scale-map: category axes', () => {
  const cats = ['a', 'b', 'c', 'd', 'e', null];

  /** Plot's x scale and the pixels it gives hint rows 0..cats.length - 1, the way DotGLMark.render receives them. */
  function renderCategories(options = {}, extraMarks = []) {
    let seen;
    const hints = cats.concat([null, null]);
    Plot.plot({
      document, width: 640, height: 200, ...options,
      marks: [
        ...extraMarks,
        Plot.dot({ length: hints.length }, {
          x: hints,
          render: (index, scales, values) => {
            seen = { sx: scales.scales.x, positions: values.x };
            return document.createElementNS('http://www.w3.org/2000/svg', 'g');
          }
        })
      ]
    });
    return seen;
  }

  const layouts = {
    normal: {},
    reversed: { x: { reverse: true } },
    inset: { x: { inset: 12 } },
    'descending range': { x: { range: [600, 40] } },
    band: { x: { type: 'band' } }
  };
  for (const [name, options] of Object.entries(layouts)) {
    it(`places every category where Plot does: ${name}`, () => {
      const { sx, positions } = renderCategories(options);
      expect(sx.type).toBe(name === 'band' ? 'band' : 'point');
      const line = categoryLine(sx, positions, cats.length, 'x');
      const middle = sx.type === 'band' ? sx.bandwidth / 2 : 0;
      cats.forEach((cat, i) => expect(line.a * i + line.b).toBeCloseTo(sx.apply(cat) + middle, 6));
    });
  }

  it('throws when the categories are not evenly spaced', () => {
    const shared = renderCategories({}, [Plot.ruleX(['aa', 'zz'])]);
    expect(() => categoryLine(shared.sx, shared.positions, cats.length, 'x')).toThrow(/the x axis doesn't place its categories evenly/);
    const explicit = renderCategories({ x: { domain: ['a', 'q', 'b', 'c', 'd', 'e', null] } });
    expect(() => categoryLine(explicit.sx, explicit.positions, cats.length, 'x')).toThrow(/evenly/);
  });

  it('handles a single category', () => {
    expect(categoryLine({ type: 'point' }, [320, 320], 1, 'x')).toEqual({ a: 0, b: 320 });
  });

  it('builds the per-frame line from a category line with a center and a shift', () => {
    const line = { a: 20, b: 50 };
    const { a, b } = axisAffine({ type: 'point' }, line, 3, -10, 'x');
    for (let code = 0; code < 8; ++code) expect(a * (code - 3) + b).toBeCloseTo(line.a * code + line.b - 10, 10);
    const desc = { type: 'linear', domain: [0, 10], range: [40, 240] };
    expect(axisAffine(desc, null, 5, -40, 'x')).toEqual(affine(desc, 5, -40, 'x'));
  });
});

describe('scale-map: domain with both ends equal', () => {
  it('maps a zero-span domain to the middle of the range, like d3', () => {
    const desc = { type: 'linear', domain: [5, 5], range: [40, 600] };
    expect(project(desc, 5)).toBe(320);
    expect(project(desc, 7)).toBe(320);
    expect(project({ type: 'log', domain: [3, 3], range: [0, 100] }, 3)).toBe(50);
  });
});
