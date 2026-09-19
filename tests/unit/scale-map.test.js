// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { scaleLinear, scaleLog, scaleSqrt, scalePow, scaleSymlog } from 'd3-scale';
import * as Plot from '@observablehq/plot';
import { transformFor, affine, axisAffine, axisTransform, categoryAxis, samePlaces, project } from '../../src/scale-map.js';

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

  /** Plot's x scale for a dot mark given `hints`, the way DotGLMark.render receives it. */
  function renderCategories(options = {}, extraMarks = [], hints = cats.concat([null, null])) {
    let sx;
    Plot.plot({
      document, width: 640, height: 200, ...options,
      marks: [
        ...extraMarks,
        Plot.dot({ length: hints.length }, {
          x: hints,
          render: (index, scales) => {
            sx = scales.scales.x;
            return document.createElementNS('http://www.w3.org/2000/svg', 'g');
          }
        })
      ]
    });
    return sx;
  }

  /** Checks that the line through each category's place lands where Plot puts that category. */
  function expectPlotPlaces(sx, list) {
    const axis = categoryAxis(sx, list);
    const middle = sx.type === 'band' ? sx.bandwidth / 2 : 0;
    list.forEach((cat, i) => expect(axis.a * axis.pos[i] + axis.b).toBeCloseTo(sx.apply(cat) + middle, 6));
    return axis;
  }

  const layouts = {
    normal: {},
    reversed: { x: { reverse: true } },
    inset: { x: { inset: 12 } },
    'descending range': { x: { range: [600, 40] } },
    band: { x: { type: 'band' } },
    'reversed band': { x: { type: 'band', reverse: true } }
  };
  for (const [name, options] of Object.entries(layouts)) {
    it(`places every category where Plot does: ${name}`, () => {
      const sx = renderCategories(options);
      expect(sx.type).toBe(name.includes('band') ? 'band' : 'point');
      const axis = expectPlotPlaces(sx, cats);
      // Plot's reverse option reverses the domain, so the places count from the other end.
      expect(Array.from(axis.pos)).toEqual(cats.map(c => sx.domain.indexOf(c)));
    });
  }

  it('places the categories of a domain that has more than the data: an explicit domain, or another mark on the axis', () => {
    const explicit = renderCategories({ x: { domain: ['a', 'q', 'b', 'c', 'd', 'e', null] } });
    expect(Array.from(expectPlotPlaces(explicit, cats).pos)).toEqual([0, 2, 3, 4, 5, 6]);
    const shared = renderCategories({}, [Plot.ruleX(['aa', 'zz'])]);
    expectPlotPlaces(shared, cats);
    // A filtered layer whose data skips 'b' and 'd', over an axis that still lists them.
    const layered = renderCategories({}, [Plot.dot(cats, { x: d => d })], ['a', 'c', 'e', null]);
    expect(Array.from(expectPlotPlaces(layered, cats).pos)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('gives NaN to a category the domain leaves out, so its dots are not drawn', () => {
    const sx = renderCategories({ x: { domain: ['e', 'a'] } });
    const axis = categoryAxis(sx, cats);
    expect(Array.from(axis.pos)).toEqual([1, NaN, NaN, NaN, 0, NaN]);
    const tx = axisTransform(sx, axis, 'x');
    expect(axis.a * tx(4) + axis.b).toBeCloseTo(sx.apply('e'), 6);
    expect(tx(1)).toBeNaN();
    // The hidden code is past the end of the list.
    expect(tx(255)).toBeNaN();
  });

  it('handles a single category and an empty domain', () => {
    const one = renderCategories({}, [], ['c', 'c']);
    const axis = categoryAxis(one, cats);
    expect(axis.a).toBe(0);
    expect(axis.b).toBeCloseTo(one.apply('c'), 6);
    expect(Array.from(axis.pos)).toEqual([NaN, NaN, 0, NaN, NaN, NaN]);
    expect(categoryAxis({ type: 'point', domain: [], apply: () => undefined }, ['a'])).toEqual({ a: 0, b: 0, pos: Float64Array.from([NaN]) });
  });

  it('places no category on a number scale, which Plot picks when only the empty value is left', () => {
    // Plot's dot drops every row here and skips render, so read the scale off the figure.
    const sx = Plot.plot({ document, marks: [Plot.dot({ length: 2 }, { x: [null, null] })] }).scale('x');
    expect(sx.type).toBe('linear');
    expect(Array.from(categoryAxis(sx, cats).pos).every(Number.isNaN)).toBe(true);
  });

  it('uses the scale\'s curve for an axis that is not drawn from category codes', () => {
    const desc = { type: 'log', domain: [1, 100], range: [0, 100] };
    expect(axisTransform(desc, null, 'x')(10)).toBe(Math.log(10));
  });

  it('compares place tables entry by entry, NaN included', () => {
    expect(samePlaces(null, null)).toBe(true);
    expect(samePlaces(Float64Array.from([0, NaN]), Float64Array.from([0, NaN]))).toBe(true);
    expect(samePlaces(Float64Array.from([0, 1]), Float64Array.from([0, NaN]))).toBe(false);
    expect(samePlaces(Float64Array.from([0]), null)).toBe(false);
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
