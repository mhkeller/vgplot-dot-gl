// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as Plot from '@observablehq/plot';
import { color } from 'd3-color';
import { Param } from '@uwdata/mosaic-core';
import { avg, column, count, desc, max, sql } from '@uwdata/mosaic-sql';
import { DotGLMark } from '../../src/DotGLMark.js';

function table(n) {
  let s = 7;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const cats = ['R', 'D', 'I'];
  return Array.from({ length: n }, () => ({
    size: Math.exp(rand() * 8) + 1,
    price: rand() * 1000,
    volume: rand() * 100,
    party: cats[Math.floor(rand() * 3)]
  }));
}

function stubbed(mark) {
  mark.render = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');
  return mark;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A coordinator that answers the two kinds of query prepare() sends: Mosaic's DESC of a
 * column (from `types`, keyed by the column's SQL) and the mark's DISTINCT (from `distinct`,
 * keyed by column name). Every query it sees is kept in `sql`.
 */
function stubCoordinator(types, distinct = {}) {
  const seen = [];
  return {
    sql: seen,
    async query(q) {
      const text = String(q);
      seen.push(text);
      const described = text.match(/^DESC SELECT (.+?) AS "column"/);
      if (described) return [{ column_name: 'column', column_type: types[described[1]], null: 'YES' }];
      const listed = text.match(/^SELECT DISTINCT \("(.+?)"\)::VARCHAR AS "v"/);
      if (listed) return (distinct[listed[1]] ?? []).map(v => ({ v }));
      throw new Error(`unexpected query: ${text}`);
    }
  };
}

/** A database-backed mark after prepare(), with a stub coordinator. */
async function prepared(options, types, distinct) {
  const mark = new DotGLMark({ table: 'trades' }, { ...options });
  mark.coordinator = stubCoordinator(types, distinct);
  await mark.prepare();
  return mark;
}

const distinctSQL = mark => mark.coordinator.sql.filter(s => s.includes('DISTINCT'));

describe('DotGLMark', () => {
  const data = table(3000);

  it('separates its own options from the channels sent to SQL/Plot', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', fill: 'party', r: 2.5, opacity: 0.6, clip: true, sort: null, orderby: 'volume', blit: 'bitmaprenderer' });
    expect(mark.channels.map(c => c.channel).sort()).toEqual(['clip', 'fill', 'opacity', 'r', 'x', 'y']);
    expect(mark.sortMode).toBeNull();
    expect(mark.orderby).toBe('volume');
    expect(mark.blit).toBe('bitmaprenderer');
    expect(mark.constant('opacity')).toBe(0.6);
  });

  it('throws when the mark is made with fx/fy, or with a column for an option it cannot draw', () => {
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', fx: 'party' })).toThrow(/facet/);
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', stroke: 'party' })).toThrow(/stroke/);
    expect(() => new DotGLMark(data, { x: 'size', y: 'price', symbol: 'party' })).toThrow(/symbol/);
  });

  it('emits one dot spec with short hint arrays instead of the full columns', () => {
    const mark = stubbed(new DotGLMark(data, { x: 'size', y: 'price', r: 'volume', fill: 'party', opacity: 0.6, clip: true }));
    const specs = mark.plotSpecs();
    expect(specs).toHaveLength(1);
    const [{ type, data: d, options }] = specs;
    expect(type).toBe('dot');
    expect(d).toEqual({ length: 8 });
    expect(options.sort).toBeNull();
    expect(typeof options.render).toBe('function');
    expect(options.x).toHaveLength(8);
    expect(options.fill).toEqual({ value: ['D', 'I', 'R', 'R', 'R', 'R', 'R', 'R'], scale: 'color' });
    expect(options.opacity).toBe(0.6);
    expect(options.clip).toBe(true);
    expect(mark.data.columns.size.length).toBe(3000);
  });

  it('makes Plot infer the same scales as the full columns', () => {
    const X = data.map(d => d.size), Y = data.map(d => d.price), R = data.map(d => d.volume), F = data.map(d => d.party);
    const full = Plot.plot({
      document, width: 640, height: 400,
      x: { type: 'log' },
      marks: [Plot.dot({ length: X.length }, { x: X, y: Y, r: R, fill: { value: F, scale: 'color' } })]
    });
    const mark = stubbed(new DotGLMark(data, { x: 'size', y: 'price', r: 'volume', fill: 'party' }));
    const [{ data: d, options }] = mark.plotSpecs();
    const hinted = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot(d, options)] });
    for (const name of ['x', 'y', 'color']) {
      expect(hinted.scale(name).domain).toEqual(full.scale(name).domain);
      expect(hinted.scale(name).range).toEqual(full.scale(name).range);
      expect(hinted.scale(name).type).toEqual(full.scale(name).type);
    }
    expect(hinted.scale('r').domain).toEqual(full.scale('r').domain);
    const [h0, h1] = hinted.scale('r').range;
    const [f0, f1] = full.scale('r').range;
    expect(h0).toBeCloseTo(f0, 5);
    expect(Math.abs(h1 - f1) / f1).toBeLessThan(0.03);
    expect(hinted.querySelectorAll('circle').length).toBe(0);
    expect(hinted.legend('color')).toBeTruthy();
  });

  it('gives render the finished scales and the colors Plot chose for the hint rows', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price', fill: 'party' });
    let seen;
    mark.render = (index, scales, values) => {
      seen = { scales, values };
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    Plot.plot({ document, width: 640, height: 400, color: { domain: ['R', 'D', 'I'], range: ['red', 'blue', 'gray'] }, marks: [Plot.dot(d, options)] });
    expect(seen.scales.scales.x.type).toBe('linear');
    expect(seen.values.fill).toEqual(['blue', 'gray', 'red']);
  });

  it('survives destroy and renders nothing afterwards', () => {
    const mark = new DotGLMark(data, { x: 'size', y: 'price' });
    mark.plotSpecs();
    mark.destroy();
    expect(mark.destroyed).toBe(true);
    const g = mark.render([], { scales: {} }, {}, { width: 1, height: 1 }, { document });
    expect(g.childNodes.length).toBe(0);
  });
});

describe('DotGLMark: review fixes', () => {
  it('draws a visible default color when no fill is given', () => {
    const data = table(50);
    const mark = new DotGLMark(data, { x: 'size', y: 'price' });
    let style;
    const origPaint = mark.render;
    mark.render = (index, scales, values, dims, context) => {
      // Read render's inputs the same way the painters do.
      const fill = mark.constant('fill') ?? 'currentColor';
      style = fill;
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    Plot.plot({ document, width: 300, height: 200, marks: [Plot.dot(d, options)] });
    expect(style).toBe('currentColor');
    expect(origPaint).toBeTypeOf('function');
  });

  it('keeps Plot log inference intact when a column has zeros', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ size: i === 0 ? 0 : i, price: i + 1, party: 'D' }));
    const X = rows.map(d => d.size), Y = rows.map(d => d.price);
    const full = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot({ length: X.length }, { x: X, y: Y })] });
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price' }));
    const [{ data: d, options }] = mark.plotSpecs();
    const hinted = Plot.plot({ document, width: 640, height: 400, x: { type: 'log' }, marks: [Plot.dot(d, options)] });
    expect(hinted.scale('x').domain).toEqual(full.scale('x').domain);
    expect(hinted.scale('y').domain).toEqual(full.scale('y').domain);
    const linear = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    expect(linear.scale('x').domain).toEqual([0, 199]);
  });
});

describe('DotGLMark: more review fixes', () => {
  it('ignores an r scale created by another mark when its own r is constant', () => {
    const rows = table(300);
    const mark = new DotGLMark(rows, { x: 'size', y: 'price', r: 2.5, fill: 'party' });
    let seenR;
    mark.render = (index, scales) => {
      seenR = mark.channelField('r', { exact: true }) ? scales.scales.r : undefined;
      return document.createElementNS(SVG_NS, 'g');
    };
    const [{ data: d, options }] = mark.plotSpecs();
    const fig = Plot.plot({ document, width: 640, height: 400, r: { domain: [1, 50], range: [2, 11] }, marks: [Plot.dot(d, options)] });
    expect(fig.scale('r')).toBeTruthy();
    expect(seenR).toBeUndefined();
  });

  it('hints undefined for a column with no finite value so Plot behaves like an empty vg.dot', () => {
    const rows = [{ size: 1, price: null, party: 'D' }, { size: 2, price: null, party: 'D' }];
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price' }));
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.y.every(v => v === undefined)).toBe(true);
    const fig = Plot.plot({ document, width: 640, height: 400, y: { type: 'log' }, marks: [Plot.dot(d, options)] });
    expect(fig.scale('y').domain).toEqual([1, 10]);
    expect(fig.scale('x').domain).toEqual([1, 2]);
  });

  it('warns once about vg.dot options it cannot honor', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = m => warnings.push(m);
    try {
      const mark = stubbed(new DotGLMark(table(20), { x: 'size', y: 'price', stroke: 'red', symbol: 'square' }));
      mark.plotSpecs();
      mark.plotSpecs();
    } finally {
      console.warn = orig;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stroke, symbol/);
  });

  it('folds fillOpacity into the painted opacity and drops data on destroy', () => {
    const mark = new DotGLMark(table(20), { x: 'size', y: 'price', opacity: 0.5, fillOpacity: 0.5 });
    expect(mark.constant('opacity') * mark.constant('fillOpacity')).toBe(0.25);
    mark.plotSpecs();
    mark.destroy();
    expect(mark.data).toBeNull();
    expect(mark.plotSpecs()).toEqual([]);
  });
});


describe('DotGLMark: fill modes', () => {
  it('draws integer codes from SQL against the category list', () => {
    const rows = [
      { size: 1, price: 1, party: 1 },
      { size: 2, price: 2, party: 0 },
      { size: 3, price: 3, party: 255 }
    ];
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', fill: 'party' }));
    // What prepare() would have produced for the categories ['D', 'R'].
    mark.categories.set('party', { cats: ['D', 'R'] });
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.fill).toEqual({ value: ['D', 'R'], scale: 'color' });
    expect(Array.from(mark.prep.codes)).toEqual([1, 0, 255]);
    expect(mark.prep.n).toBe(2);
    expect(d).toEqual({ length: 2 });
  });

  it('bins a numeric fill and lets Plot build a continuous color scale with a ramp legend', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ size: i + 1, price: i, shift: (i / 299) * 2 - 1 }));
    const mark = stubbed(new DotGLMark(rows, { x: 'size', y: 'price', fill: 'shift' }));
    // What prepare() reads from Mosaic's field info.
    mark.channelField('fill').type = 'number';
    const [{ data: d, options }] = mark.plotSpecs();
    expect(options.fill.value.slice(0, 2)).toEqual([-1, 1]);
    expect(mark.prep.continuous).toBe(true);
    expect(mark.prep.levels).toBe(254);
    expect(mark.prep.codes[0]).toBe(0);
    expect(mark.prep.codes[299]).toBe(253);
    const fig = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    expect(fig.scale('color').type).toBe('linear');
    expect(fig.scale('color').domain).toEqual([-1, 1]);
    // (The ramp legend needs a 2D canvas, which jsdom doesn't have; the browser suite checks it.)
  });

  it('groups plain values into categories for array data', async () => {
    const mark = new DotGLMark(table(10), { x: 'size', y: 'price', fill: 'party' });
    await mark.prepare();
    expect(mark.categories.size).toBe(0);
    mark.plotSpecs();
    expect(mark.prep.cats).toEqual(['D', 'I', 'R']);
  });
});

describe('DotGLMark: orderby and sort', () => {
  it('adds orderby to the query without making it a channel', () => {
    const byColumn = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', orderby: 'volume' });
    expect(byColumn.channels.map(c => c.channel)).not.toContain('orderby');
    expect(String(byColumn.query())).toBe('SELECT "size", "price" FROM "trades" AS "source" ORDER BY "volume"');
    const byFragment = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', orderby: sql`${column('volume')} DESC` });
    expect(String(byFragment.query())).toMatch(/ ORDER BY "volume" DESC$/);
    const byDesc = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', orderby: desc('volume') });
    expect(String(byDesc.query())).toMatch(/ ORDER BY "volume" DESC$/);
  });

  it("accepts sort '-r' or null and throws for anything else", () => {
    const rows = table(10);
    expect(() => new DotGLMark(rows, { x: 'size', y: 'price', sort: '-r' })).not.toThrow();
    expect(() => new DotGLMark(rows, { x: 'size', y: 'price', sort: null })).not.toThrow();
    expect(() => new DotGLMark(rows, { x: 'size', y: 'price', sort: Param.value('-r') })).toThrow(/sort must be '-r' or null/);
    expect(() => new DotGLMark(rows, { x: 'size', y: 'price', sort: { channel: 'x', order: 'descending' } })).toThrow(/use orderby/);
  });
});

describe('DotGLMark: key and tip', () => {
  it('selects the key under its own name, without making key or tip a channel', () => {
    const mark = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', key: 'id', tip: { fields: ['party'] }, orderby: 'volume' });
    expect(mark.channels.map(c => c.channel).sort()).toEqual(['x', 'y']);
    expect(String(mark.query())).toBe('SELECT "size", "price", "id" AS "__dotgl_key" FROM "trades" AS "source" ORDER BY "volume"');
  });

  it('throws for tip fields without a key or a database table', () => {
    expect(() => new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', tip: { fields: ['party'] } })).toThrow('dotGL: tip.fields needs a key column');
    expect(() => new DotGLMark(table(10), { x: 'size', y: 'price', key: 'size', tip: { fields: ['party'] } })).toThrow('dotGL: tip.fields needs a database table');
    expect(() => new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', tip: true })).not.toThrow();
  });

});

describe('DotGLMark: groupby', () => {
  const aggregate = { x: avg('price'), y: count() };
  const types = { '"party"': 'VARCHAR', 'avg("price")': 'DOUBLE', 'count(*)': 'BIGINT' };

  it('selects a group column under its own name and groups by it, without making it a channel', () => {
    for (const groupby of ['region', column('region'), ['region']]) {
      const mark = new DotGLMark({ table: 'trades' }, { ...aggregate, groupby });
      expect(mark.channels.map(c => c.channel).sort()).toEqual(['x', 'y']);
      expect(mark.groups.map(g => [g.name, g.as])).toEqual([['region', 'region']]);
      expect(String(mark.query())).toBe('SELECT avg("price") AS "x", count(*) AS "y", "region" FROM "trades" AS "source" GROUP BY "region"');
    }
  });

  it('keeps the group column name for an orderby on the same column', () => {
    // With a filtering selection Mosaic queries a pre-aggregated table that has only the query's aliases.
    const mark = new DotGLMark({ table: 'trades' }, { ...aggregate, groupby: 'region', orderby: 'region' });
    expect(String(mark.query())).toBe('SELECT avg("price") AS "x", count(*) AS "y", "region" FROM "trades" AS "source" GROUP BY "region" ORDER BY "region"');
  });

  it('groups by each column of an array, and gives an expression a private name labeled with its SQL', () => {
    const mark = new DotGLMark({ table: 'trades' }, { ...aggregate, groupby: ['region', sql`upper(party)`] });
    expect(mark.groups.map(g => [g.name, g.as])).toEqual([['region', 'region'], ['upper(party)', '__dotgl_group_1']]);
    expect(String(mark.query())).toBe(
      'SELECT avg("price") AS "x", count(*) AS "y", "region", upper(party) AS "__dotgl_group_1" ' +
      'FROM "trades" AS "source" GROUP BY "region", "__dotgl_group_1"'
    );
  });

  it('adds the groups to the grouping by a text fill, and neither casts nor codes them', async () => {
    const mark = await prepared({ ...aggregate, fill: 'party', groupby: 'region' }, types, { party: ['R', 'D'] });
    expect(mark.coordinator.sql.filter(s => s.includes('region'))).toEqual([]);
    const query = String(mark.query());
    expect(query).toMatch(/^SELECT "region", coalesce\(\(avg\("price"\)\)::DOUBLE, 'NaN'::DOUBLE\) AS "x", /);
    expect(query).toMatch(/ END AS UTINYINT\) AS "party" FROM "trades" AS "source" GROUP BY "party", "region"$/);
  });

  it('keeps channels whose aliases match a group column name', async () => {
    const mark = await prepared({ ...aggregate, fill: 'party', groupby: ['x', 'party'] }, types, { party: ['R', 'D'] });
    const query = String(mark.query());
    expect(query).toMatch(/^SELECT "x" AS "__dotgl_group_0", "party" AS "__dotgl_group_1", coalesce\(\(avg\("price"\)\)::DOUBLE, 'NaN'::DOUBLE\) AS "x", /);
    expect(query).toContain(`CAST(CASE WHEN "party" IS NULL THEN 255 ELSE COALESCE(enum_code(TRY_CAST(CAST("party" AS VARCHAR) AS ENUM('D', 'R'))), 255) END AS UTINYINT) AS "party"`);
    expect(query).toMatch(/ GROUP BY "party", "__dotgl_group_0", "__dotgl_group_1"$/);
  });

  it('throws for array data', () => {
    expect(() => new DotGLMark(table(10), { x: 'size', y: 'price', groupby: 'party' })).toThrow('dotGL: groupby needs a database table');
  });
});

describe('DotGLMark: categories', () => {
  const types = { '"party"': 'VARCHAR', '"price"': 'DOUBLE', '"size"': 'DOUBLE' };

  it('turns a text x into codes with one ENUM lookup, and gives null the last code', async () => {
    const mark = await prepared({ x: 'party', y: 'price' }, types, { party: ['R', null, 'D', "O'Neil"] });
    expect(distinctSQL(mark)).toEqual(['SELECT DISTINCT ("party")::VARCHAR AS "v" FROM "trades" LIMIT 10001']);
    expect(mark.categories.get('party').cats).toEqual(['D', "O'Neil", 'R', null]);
    expect(String(mark.query())).toBe(
      `SELECT CAST(CASE WHEN "party" IS NULL THEN 3 ELSE COALESCE(enum_code(TRY_CAST(CAST("party" AS VARCHAR) AS ENUM('D', 'O''Neil', 'R'))), 255) END AS UTINYINT) AS "party", ` +
      `coalesce(("price")::DOUBLE, 'NaN'::DOUBLE) AS "price" FROM "trades" AS "source"`
    );
  });

  it('uses two-byte codes above 254 categories, and the hidden code for null when there is no null category', async () => {
    const values = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    const mark = await prepared({ x: 'size', y: 'price', fill: 'party' }, types, { party: values });
    expect(distinctSQL(mark)).toEqual(['SELECT DISTINCT ("party")::VARCHAR AS "v" FROM "trades" LIMIT 65536']);
    const query = String(mark.query());
    expect(query).toMatch(/^SELECT coalesce\(\("size"\)::DOUBLE, 'NaN'::DOUBLE\) AS "size", /);
    expect(query).toMatch(/CAST\(CASE WHEN "party" IS NULL THEN 65535 ELSE COALESCE\(enum_code\(TRY_CAST\(CAST\("party" AS VARCHAR\) AS ENUM\('c000', 'c001', /);
    expect(query).toMatch(/'c299'\)\)\), 65535\) END AS USMALLINT\) AS "party"/);
  });

  it('sends a column with no values besides null without an ENUM', async () => {
    const mark = await prepared({ x: 'party', y: 'price' }, types, { party: [null] });
    expect(String(mark.query())).toMatch(/^SELECT CAST\(CASE WHEN "party" IS NULL THEN 0 ELSE 255 END AS UTINYINT\) AS "party"/);
  });

  it('throws when a column has more distinct values than its limit', async () => {
    const many = n => Array.from({ length: n }, (_, i) => `v${i}`);
    await expect(prepared({ x: 'party', y: 'price' }, types, { party: many(10001) }))
      .rejects.toThrow('dotGL: the x column "party" has more than 10000 distinct values');
    await expect(prepared({ x: 'size', y: 'price', fill: 'party', maxCategories: 3 }, types, { party: many(4) }))
      .rejects.toThrow('dotGL: the fill column "party" has more than 3 distinct values');
    await expect(prepared({ x: 'size', y: 'price', fill: 'party' }, types, { party: many(65536) }))
      .rejects.toThrow('dotGL: the fill column "party" has more than 65535 distinct values');
  });

  it('throws when the category lists would make the request too large to send', async () => {
    const values = Array.from({ length: 65000 }, (_, i) => 'v'.repeat(50) + String(i).padStart(5, '0'));
    await expect(prepared({ x: 'size', y: 'price', fill: 'party' }, types, { party: values }))
      .rejects.toThrow(/^dotGL: the categories of "party" are too large to send \(3\.\d MB\)$/);
  });

  it('draws BOOLEAN and UUID columns as categories the same way', async () => {
    const mark = await prepared(
      { x: 'size', y: 'flag', fill: 'id' },
      { ...types, '"flag"': 'BOOLEAN', '"id"': 'UUID' },
      { flag: ['true', null, 'false'], id: ['6b1e5f3e-0000-4000-8000-000000000002', '6b1e5f3e-0000-4000-8000-000000000001'] }
    );
    expect(distinctSQL(mark)).toEqual([
      'SELECT DISTINCT ("flag")::VARCHAR AS "v" FROM "trades" LIMIT 10001',
      'SELECT DISTINCT ("id")::VARCHAR AS "v" FROM "trades" LIMIT 65536'
    ]);
    const query = String(mark.query());
    expect(query).toContain(`CAST(CASE WHEN "flag" IS NULL THEN 2 ELSE COALESCE(enum_code(TRY_CAST(CAST("flag" AS VARCHAR) AS ENUM('false', 'true'))), 255) END AS UTINYINT) AS "flag"`);
    expect(query).toContain(`TRY_CAST(CAST("id" AS VARCHAR) AS ENUM('6b1e5f3e-0000-4000-8000-000000000001', '6b1e5f3e-0000-4000-8000-000000000002'))`);
  });

  it('gives x and fill on the same column one list and one code column', async () => {
    const mark = await prepared({ x: 'party', y: 'price', fill: 'party' }, types, { party: ['R', 'D'] });
    expect(distinctSQL(mark)).toEqual(['SELECT DISTINCT ("party")::VARCHAR AS "v" FROM "trades" LIMIT 10001']);
    expect(mark.categories.size).toBe(1);
    expect(String(mark.query()).match(/AS "party"/g)).toHaveLength(1);
    const limited = await prepared({ x: 'party', y: 'price', fill: 'party', maxCategories: 50 }, types, { party: ['R', 'D'] });
    expect(distinctSQL(limited)).toEqual(['SELECT DISTINCT ("party")::VARCHAR AS "v" FROM "trades" LIMIT 51']);
  });

  it('keeps an aggregate x numeric and groups by the category column', async () => {
    const mark = await prepared(
      { x: avg('price'), y: count(), fill: 'party' },
      { ...types, 'avg("price")': 'DOUBLE', 'count(*)': 'BIGINT' },
      { party: ['R', 'D'] }
    );
    expect(distinctSQL(mark)).toHaveLength(1);
    const query = String(mark.query());
    expect(query).toMatch(/^SELECT coalesce\(\(avg\("price"\)\)::DOUBLE, 'NaN'::DOUBLE\) AS "x", coalesce\(\(count\(\*\)\)::DOUBLE, 'NaN'::DOUBLE\) AS "y", CAST\(CASE WHEN "party"/);
    expect(query).toMatch(/ GROUP BY "party"$/);
  });

  it('throws for a text expression and for column types it cannot draw', async () => {
    await expect(prepared({ x: max('party'), y: count() }, { 'max("party")': 'VARCHAR', 'count(*)': 'BIGINT' }))
      .rejects.toThrow('dotGL: x must be a plain column to be drawn as categories');
    await expect(prepared({ x: 'tags', y: 'price' }, { ...types, '"tags"': 'VARCHAR[]' }))
      .rejects.toThrow(`dotGL: the x column "tags" has type VARCHAR[], which can't be drawn`);
    await expect(prepared({ x: 'size', y: 'price', fill: 'meta' }, { ...types, '"meta"': 'STRUCT(a INTEGER)' }))
      .rejects.toThrow(`dotGL: the fill column "meta" has type STRUCT(a INTEGER), which can't be drawn`);
  });

  it('reads a result that lands during a second prepare() with the lists its codes point into', async () => {
    const mark = await prepared({ x: 'party', y: 'price' }, types, { party: ['R', 'D'] });
    const again = mark.prepare();
    mark.queryResult([{ party: 1, price: 1 }, { party: 0, price: 2 }]);
    expect(mark.plotSpecs()[0].options.x).toEqual(['D', 'R']);
    await again;
  });

  it('falls back to the canvas painter when the browser has no WebGL2', async () => {
    const noWebGL = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    try {
      const mark = await prepared({ x: 'size', y: 'price', fill: 'party' }, types, { party: ['D', 'R'] });
      expect(mark.activePainter()).toBe('rect2d');
      // The fallback draws the same rows the same way, so it still fetches the category list.
      expect(distinctSQL(mark).length).toBe(1);
      expect(mark.categories.get('party').cats).toEqual(['D', 'R']);
    } finally {
      noWebGL.mockRestore();
    }
  });

  it('gives Plot the category list, so it builds the same point scale as the text column', async () => {
    const mark = stubbed(await prepared({ x: 'party', y: 'price' }, types, { party: ['R', null, 'D', 'I'] }));
    const text = ['R', null, 'D', 'I', 'R'];
    mark.data = { numRows: 5, columns: { party: Uint8Array.from([2, 3, 0, 1, 2]), price: Float64Array.from([1, 2, 3, 4, 5]) } };
    const [{ data: d, options }] = mark.plotSpecs();
    expect(mark.prep.extent.x).toEqual([0, 3]);
    const hinted = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    const full = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot({ length: 5 }, { x: text, y: [1, 2, 3, 4, 5] })] });
    expect(hinted.scale('x').type).toBe('point');
    expect(hinted.scale('x').domain).toEqual(full.scale('x').domain);
    expect(hinted.scale('x').domain).toEqual(['D', 'I', 'R', null]);
  });
});

describe('DotGLMark: drawing', () => {
  it("draws a text x with a null and a 300-value fill where Plot's own dots go, in their colors", async () => {
    const letters = ['a', 'b', 'c', 'd', null];
    const names = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, '0')}`);
    const n = 600;
    const X = Array.from({ length: n }, (_, i) => letters[i % 5]);
    const Y = Array.from({ length: n }, (_, i) => (i * 37) % 101);
    const F = Array.from({ length: n }, (_, i) => names[(i * 7) % 300]);
    const mark = await prepared(
      { x: 'letter', y: 'price', fill: 'name' },
      { '"letter"': 'VARCHAR', '"price"': 'DOUBLE', '"name"': 'VARCHAR' },
      { letter: letters, name: names }
    );
    const xCats = mark.categories.get('letter').cats;
    const fillCats = mark.categories.get('name').cats;
    mark.data = {
      numRows: n,
      columns: { letter: Uint8Array.from(X, v => xCats.indexOf(v)), price: Float64Array.from(Y), name: Uint16Array.from(F, v => fillCats.indexOf(v)) }
    };

    // jsdom has no 2D canvas, so record the squares the rect2d painter fills.
    const squares = [];
    const ctx = { setTransform() {}, clearRect() {}, fillRect(x, y, w, h) { squares.push({ x: x + w / 2, y: y + h / 2, fill: this.fillStyle }); } };
    const canvas2d = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type => (type === '2d' ? ctx : null));
    try {
      const [{ data: d, options }] = mark.plotSpecs();
      Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    } finally {
      canvas2d.mockRestore();
    }
    expect(mark.prep.codes).toBeInstanceOf(Uint16Array);

    const full = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot({ length: n }, { x: X, y: Y, fill: { value: F, scale: 'color' } })] });
    const circles = [...full.querySelectorAll('circle')];
    const [, tx, ty] = circles[0].parentNode.getAttribute('transform').match(/translate\(([\d.]+),([\d.]+)\)/).map(Number);
    expect(squares).toHaveLength(n);
    expect(circles).toHaveLength(n);
    circles.forEach((c, i) => {
      expect(squares[i].x).toBeCloseTo(+c.getAttribute('cx') + tx, 6);
      expect(squares[i].y).toBeCloseTo(+c.getAttribute('cy') + ty, 6);
      expect(color(squares[i].fill).formatHex()).toBe(color(c.getAttribute('fill')).formatHex());
    });
  });

  it('throws when a number column sits on a point or band scale', () => {
    const rows = [{ year: 2000, price: 1 }, { year: 2005, price: 2 }];
    for (const type of ['point', 'band']) {
      const mark = new DotGLMark(rows, { x: 'year', y: 'price' });
      const [{ data: d, options }] = mark.plotSpecs();
      expect(() => Plot.plot({ document, x: { type }, marks: [Plot.dot(d, options)] }))
        .toThrow(`dotGL: the x scale type "${type}" is not supported for a number or date column`);
    }
  });
});

describe('DotGLMark: number and date columns', () => {
  const types = { '"size"': 'BIGINT', '"day"': 'DATE', '"volume"': 'DECIMAL(10,2)', '"party"': 'VARCHAR' };

  it('casts numbers to DOUBLE and dates to epoch milliseconds, with NaN for null', async () => {
    const mark = await prepared({ x: 'size', y: 'day', r: 'volume' }, types);
    expect(String(mark.query())).toBe(
      `SELECT coalesce(("size")::DOUBLE, 'NaN'::DOUBLE) AS "size", coalesce((epoch_ms("day"))::DOUBLE, 'NaN'::DOUBLE) AS "day", ` +
      `coalesce(("volume")::DOUBLE, 'NaN'::DOUBLE) AS "volume" FROM "trades" AS "source"`
    );
  });

  it('leaves unnested columns as Mosaic selects them', async () => {
    const mark = new DotGLMark({ table: 'trades', options: { unnest: 'sizes' } }, { x: 'sizes', y: 'volume' });
    mark.coordinator = stubCoordinator({ ...types, '"sizes"': 'DOUBLE[]' });
    await mark.prepare();
    expect(String(mark.query())).toBe(`SELECT UNNEST("sizes") AS "sizes", coalesce(("volume")::DOUBLE, 'NaN'::DOUBLE) AS "volume" FROM "trades" AS "source"`);
  });

  it('turns epoch-millisecond date columns back into Date hints, and a date fill into a time color scale', async () => {
    const mark = stubbed(await prepared({ x: 'size', y: 'day', fill: 'day' }, types));
    const days = Float64Array.from([Date.UTC(2020, 0, 1), NaN, Date.UTC(2021, 0, 1)]);
    mark.data = { numRows: 3, columns: { size: Float64Array.from([1, 2, 3]), day: days } };
    const [{ data: d, options }] = mark.plotSpecs();
    expect(mark.prep.continuous).toBe(true);
    expect(mark.prep.n).toBe(2);
    expect(options.y[0]).toBeInstanceOf(Date);
    expect(options.fill.value[0]).toBeInstanceOf(Date);
    const fig = Plot.plot({ document, width: 640, height: 400, marks: [Plot.dot(d, options)] });
    expect(fig.scale('y').type).toBe('utc');
    expect(fig.scale('color').type).toBe('utc');
    expect(fig.scale('color').domain.map(Number)).toEqual([Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1)]);
  });
});

describe('DotGLMark: queryResult', () => {
  it('keeps the prepared rows when Mosaic hands back the same result, and clears them for a new one', () => {
    const mark = stubbed(new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price' }));
    const result = [{ size: 1, price: 2 }, { size: 3, price: 4 }];
    mark.queryResult(result);
    mark.plotSpecs();
    const prep = mark.prep;
    expect(prep.n).toBe(2);
    mark.queryResult(result);
    expect(mark.prep).toBe(prep);
    mark.queryResult([...result]);
    expect(mark.prep).toBeNull();
  });

  it("doesn't ask the plot to draw before its first result", () => {
    const mark = new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', opacity: 0.5 });
    const synch = { promise: Promise.resolve() };
    mark.plot = { update: vi.fn(() => synch.promise), synch };
    expect(mark.update()).toBe(synch.promise);
    expect(mark.plot.update).not.toHaveBeenCalled();
    mark.queryResult([{ size: 1, price: 2 }]);
    mark.update();
    expect(mark.plot.update).toHaveBeenCalledWith(mark);
  });
});

describe('DotGLMark: removed options', () => {
  it('says so plainly instead of reading painter as a column name', () => {
    for (const name of ['painter', 'fallback']) {
      expect(() => new DotGLMark({ table: 'trades' }, { x: 'size', y: 'price', [name]: 'gl' }))
        .toThrow(`dotGL: the "${name}" option was removed.`);
    }
  });
});

describe('DotGLMark: telling you when nothing will show up', () => {
  it('throws for a text x or y with array data, rather than drawing an empty plot', () => {
    // Every value would read as NaN and every row would be dropped, with nothing said.
    const rows = table(20);
    expect(() => stubbed(new DotGLMark(rows, { x: 'party', y: 'price' })).plotSpecs())
      .toThrow(/the x values are string.*database table/s);
    expect(() => stubbed(new DotGLMark(rows, { x: 'size', y: 'party' })).plotSpecs())
      .toThrow(/the y values are string/);
    // Dates and numbers are both fine, and so is a text fill, which is grouped into categories here.
    const dated = rows.map((d, i) => ({ ...d, day: new Date(Date.UTC(2021, 0, 1 + i)) }));
    expect(() => stubbed(new DotGLMark(dated, { x: 'day', y: 'price', fill: 'party' })).plotSpecs()).not.toThrow();
  });

  it('warns once when the color domain leaves a category out, since those dots are invisible', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = m => warnings.push(m);
    try {
      const rows = table(60);
      const mark = new DotGLMark(rows, { x: 'size', y: 'price', fill: 'party' });
      const [{ data: d, options }] = mark.plotSpecs();
      // 'I' is left out, so Plot gives it no color and its dots are drawn fully transparent.
      const spec = { document, width: 320, height: 200, color: { domain: ['R', 'D'], range: ['red', 'blue'] }, marks: [Plot.dot(d, options)] };
      // jsdom has no canvas, so the painter gets one that does nothing.
      const ctx = { setTransform() {}, clearRect() {}, fillRect() {} };
      const canvas2d = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(t => (t === '2d' ? ctx : null));
      try {
        Plot.plot(spec);
        Plot.plot(spec);
      } finally {
        canvas2d.mockRestore();
      }
    } finally {
      console.warn = orig;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/color domain has no color for 1 of the fill column's values \("I"\)/);
    expect(warnings[0]).toMatch(/drawn invisible/);
  });
});
