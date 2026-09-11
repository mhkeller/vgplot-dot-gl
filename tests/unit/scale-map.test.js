import { describe, it, expect } from 'vitest';
import { scaleLinear, scaleLog, scaleSqrt, scalePow, scaleSymlog } from 'd3-scale';
import { transformFor, affine, project } from '../../src/scale-map.js';

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
    expect(() => transformFor({ type: 'band' }, 'x')).toThrow(/band/);
    expect(() => affine({ type: 'linear', domain: [0, 1, 2], range: [0, 1] })).toThrow(/two-value/);
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
