// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Plot from '@observablehq/plot';
import { DotGLMark } from '../../src/DotGLMark.js';
import { DotGLTip, KEY_AS } from '../../src/tip.js';

/** A coordinator whose lookups wait until the test resolves them with rows, or rejects them. */
function coordinator() {
  const calls = [];
  // `types` gives a column an Arrow type, as a real result carries one. 9 is Arrow's time type.
  const table = (rows, types = []) => ({
    numRows: rows.length,
    getChildAt: k => ({ at: i => rows[i][Object.keys(rows[i])[k]], type: types[k] })
  });
  return {
    calls,
    query(query, options) {
      return new Promise((resolve, reject) => {
        calls.push({ sql: String(query), options, resolve: (rows, types) => resolve(table(rows, types)), reject });
      });
    }
  };
}

/**
 * A DotGLMark on table "pts" with the given columns (plus one more mark with `second` options), painted by Plot
 * with the rect2d painter into a stub canvas, inside a stand-in vgplot plot. The tip listens on Plot's SVG, whose
 * screen matrix is the identity. `key` holds the key column, which is `columns.id` unless given.
 */
function hovered(columns, options, { types = {}, sqlTypes = {}, categories = {}, attrs = {}, second = null, key = Int32Array.from(columns.id) } = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  // jsdom never matches :hover, so the pointer counts as over the plot unless a test says otherwise.
  element.matches = () => true;
  const plot = { element, interactors: [], addParams() {}, pending() {}, addInteractor(i) { this.interactors.push(i); }, getAttribute: name => attrs[name] };
  const marks = [options, second].filter(Boolean).map((o, index) => {
    const mark = new DotGLMark({ table: 'pts' }, { key: 'id', ...o });
    mark.setPlot(plot, index);
    mark.coordinator = coordinator();
    for (const [name, type] of Object.entries(types)) mark.channelField(name).type = type;
    for (const [name, sqlType] of Object.entries(sqlTypes)) mark.channelField(name).sqlType = sqlType;
    for (const [as, cats] of Object.entries(categories)) mark.categories.set(as, { cats });
    mark.data = { numRows: columns.id.length, columns: { ...columns, [KEY_AS]: key } };
    return mark;
  });
  const [mark] = marks;

  /** Renders the plot, as Mosaic does on every redraw: each tip gets the new SVG, which then replaces the old one. */
  const render = () => {
    const ctx = { setTransform() {}, clearRect() {}, fillRect() {} };
    const canvas2d = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type => (type === '2d' ? ctx : null));
    try {
      const svg = Plot.plot({ document, width: 320, height: 200, marks: marks.map(m => { const [{ data, options: o }] = m.plotSpecs(); return Plot.dot(data, o); }) });
      svg.getScreenCTM = () => ({ e: 0, f: 0, inverse() { return this; } });
      for (const tip of plot.interactors) tip.init(svg);
      element.replaceChildren(svg);
      return svg;
    } finally {
      canvas2d.mockRestore();
    }
  };
  const svg = render();
  const tip = plot.interactors[0];

  /** Moves the pointer onto row j's dot in a mark, with any `buttons` held. */
  const moveTo = (j, { on = mark, buttons = 0 } = {}) => {
    const { sx, sy, frame, prep } = on.lastPaint;
    const x = columns[on.channelField('x', { exact: true }).as][j];
    const y = columns[on.channelField('y', { exact: true }).as][j];
    const clientX = sx.apply(prep.xCats ? prep.xCats[x] : x) + frame.offset;
    const clientY = sy.apply(y) + frame.offset;
    element.querySelector('svg').dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, buttons }));
  };
  /** The tip's rows as [label, text] pairs. */
  const rows = () => [...element.querySelectorAll('.dotgl-tip tr')].map(tr => [tr.cells[0].textContent, tr.cells[1].textContent]);
  const cell = label => rows().find(([l]) => l === label)?.[1];
  return { mark, tip, tips: plot.interactors, svg, element, calls: mark.coordinator.calls, moveTo, rows, cell, render };
}

/** Ten dots in a row, far enough apart that the pointer on one never picks another. */
const line = () => ({
  id: Int32Array.from({ length: 10 }, (_, i) => 100 + i),
  a: Float64Array.from({ length: 10 }, (_, i) => i * 10),
  b: new Float64Array(10).fill(5)
});
const withFields = { x: 'a', y: 'b', r: 3, tip: { fields: ['id', 'name'] } };

describe('DotGLTip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    vi.stubGlobal('DOMPoint', class {
      constructor(x, y) { Object.assign(this, { x, y }); }
      matrixTransform(m) { return { x: this.x + m.e, y: this.y + m.f }; }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it('is added by the mark when tip is set', () => {
    const { tip, svg } = hovered(line(), withFields);
    expect(tip).toBeInstanceOf(DotGLTip);
    expect(tip.svg).toBe(svg);
  });

  it("doesn't build the pick index until 150 ms after a paint", async () => {
    const { tip, moveTo, element, svg } = hovered(line(), withFields);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(tip.index).toBeNull();
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    await vi.advanceTimersByTimeAsync(140);
    expect(tip.index).not.toBeNull();
    expect(element.querySelector('.dotgl-tip')).not.toBeNull();
    expect(svg.querySelector('circle.dotgl-ring').getAttribute('r')).toBe('3');
    expect(document.head.querySelectorAll('style[data-dotgl-tip]')).toHaveLength(1);
  });

  it('looks up nothing for rows the pointer only passes over, then the row it rests on', async () => {
    const { calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    for (let j = 0; j < 10; ++j) {
      moveTo(j);
      await vi.advanceTimersByTimeAsync(50);
      expect(cell('id')).toBe('…');
    }
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('SELECT "id", "name" FROM "pts" AS "source" WHERE ("id" = 109) LIMIT 1');
    expect(calls[0].options).toEqual({ cache: false });
    calls[0].resolve([{ id: 109, name: 'row nine' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('id')).toBe('109');
    expect(cell('name')).toBe('row nine');
  });

  it('keeps one lookup in flight and shows each result only on its own row', async () => {
    const { calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(150);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);
    calls[0].resolve([{ id: 101, name: 'one' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('…');
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toContain('("id" = 102)');
    calls[1].resolve([{ id: 102, name: 'two' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('two');
    moveTo(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(cell('name')).toBe('one');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
  });

  it('looks up only rows the pointer rests on while a lookup is in flight', async () => {
    const { calls, moveTo } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(150);
    for (const j of [2, 3, 4]) {
      moveTo(j);
      await vi.advanceTimersByTimeAsync(30);
      calls.at(-1).resolve([{ id: 100 + j - 1, name: 'passed' }]);
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map(c => c.sql.match(/= (\d+)/)[1])).toEqual(['101', '104']);
  });

  it("doesn't draw a result that arrives after new data", async () => {
    const warn = vi.spyOn(console, 'warn');
    const { mark, calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(3);
    await vi.advanceTimersByTimeAsync(150);
    mark.lastPaint = null; // what queryResult() does
    calls[0].resolve([{ id: 103, name: 'three' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('…');
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks again after the rows are reset', async () => {
    const { mark, calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(3);
    await vi.advanceTimersByTimeAsync(150);
    mark.tipRows = new Map(); // what prepare() does when the table changes
    calls[0].resolve([{ id: 103, name: 'old table' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('…');
    expect(calls).toHaveLength(2);
    calls[1].resolve([{ id: 103, name: 'new table' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('new table');
  });

  it('looks the row up again when a Param holding the fields changes', async () => {
    const fields = { value: ['id', 'name'] };
    const { mark, calls, moveTo, cell } = hovered(line(), { ...withFields, tip: { fields } });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(150);
    calls[0].resolve([{ id: 101, name: 'one' }]);
    await vi.advanceTimersByTimeAsync(0);
    const before = mark.tipRows;
    fields.value = ['id', 'label'];
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(mark.tipRows).not.toBe(before);
    expect(cell('label')).toBe('…');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls[1].sql).toBe('SELECT "id", "label" FROM "pts" AS "source" WHERE ("id" = 101) LIMIT 1');
  });

  it('leaves a value that cannot be read empty, and keeps the rest of the row', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(150);
    calls[0].resolve([{ id: 101, get name() { throw new Error('BigInt exceeds integer number representation'); } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('id')).toBe('101');
    expect(cell('name')).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows a field whose column the table spells in another case', async () => {
    const { calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(1);
    await vi.advanceTimersByTimeAsync(150);
    calls[0].resolve([{ id: 101, Name: 'one' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cell('name')).toBe('one');
  });

  it('shows empty fields and looks nothing up for a row without a key', async () => {
    const columns = line();
    const { calls, moveTo, cell } = hovered(columns, withFields, { key: Array.from(columns.id, (id, j) => (j === 2 ? null : id)) });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(0);
    expect(cell('name')).toBe('');
  });

  it('takes the ring and tip off the old SVG on a redraw, and picks again from the new paint while the pointer stays', async () => {
    const { svg, element, moveTo, cell, render } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(svg.querySelector('.dotgl-ring')).not.toBeNull();
    const next = render();
    expect(svg.querySelector('.dotgl-ring')).toBeNull();
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(next.querySelector('.dotgl-ring')).not.toBeNull();
    expect(cell('a')).toBe('20');
  });

  it("doesn't pick again after a redraw once the pointer has left the plot", async () => {
    const { element, moveTo, render } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    render();
    // Only the plot element hears a pointer that leaves right after a redraw.
    element.dispatchEvent(new PointerEvent('pointerleave'));
    await vi.advanceTimersByTimeAsync(200);
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(element.querySelector('.dotgl-tip')).not.toBeNull();
    // A plot taken out of the page and put back hears no leave at all.
    element.matches = () => false;
    render();
    await vi.advanceTimersByTimeAsync(200);
    expect(element.querySelector('.dotgl-tip')).toBeNull();
  });

  it('shows nothing while a button is held, and drops the index when the pointer leaves', async () => {
    const { tip, element, moveTo, render } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(2);
    moveTo(2, { buttons: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    render();
    await vi.advanceTimersByTimeAsync(200);
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    moveTo(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(element.querySelector('.dotgl-tip')).not.toBeNull();
    element.querySelector('svg').dispatchEvent(new PointerEvent('pointerleave'));
    expect(element.querySelector('.dotgl-tip')).toBeNull();
    expect(tip.index).toBeNull();
  });

  it('shows one tip at a time for two tip marks on one plot: the closer dot, or the later mark on a tie', async () => {
    const columns = { ...line(), c: Float64Array.from({ length: 10 }, (_, j) => (j === 7 ? 5 : 6)) };
    const { tips, element, moveTo } = hovered(columns, { x: 'a', y: 'b', r: 3, tip: true }, { second: { x: 'a', y: 'c', r: 3, tip: true } });
    const shown = () => [element.querySelectorAll('.dotgl-ring').length, element.querySelectorAll('.dotgl-tip').length, tips.map(t => t.shown?.j ?? null)];
    await vi.advanceTimersByTimeAsync(200);
    moveTo(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(shown()).toEqual([1, 1, [2, null]]);
    moveTo(2, { on: tips[1].mark });
    await vi.advanceTimersByTimeAsync(20);
    expect(shown()).toEqual([1, 1, [null, 2]]);
    moveTo(7);
    await vi.advanceTimersByTimeAsync(20);
    expect(shown()).toEqual([1, 1, [null, 7]]);
  });

  it('caches nothing when a lookup fails, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mark, calls, moveTo, cell } = hovered(line(), withFields);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(4);
    await vi.advanceTimersByTimeAsync(150);
    calls[0].reject('Cleared');
    await vi.advanceTimersByTimeAsync(0);
    expect(mark.tipRows.size).toBe(0);
    expect(cell('name')).toBe('…');
    moveTo(5);
    await vi.advanceTimersByTimeAsync(150);
    calls[1].reject(new Error('connection closed'));
    await vi.advanceTimersByTimeAsync(0);
    moveTo(4);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('shows category values as text', async () => {
    const columns = { ...line(), letter: Uint8Array.from({ length: 10 }, (_, i) => i % 3), party: Uint8Array.from({ length: 10 }, (_, i) => i % 2) };
    const { element, moveTo, rows } = hovered(columns, { x: 'letter', y: 'a', fill: 'party', r: 3, tip: true }, {
      categories: { letter: ['a', 'b', null], party: ['<b>D</b>', 'R'] }
    });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(4);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['letter', 'b'], ['a', '40'], ['party', '<b>D</b>']]);
    expect(element.querySelector('.dotgl-tip b')).toBeNull();
    expect(element.querySelector('.dotgl-tip .dotgl-swatch').style.background).not.toBe('');
    moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['letter', ''], ['a', '50'], ['party', 'R']]);
  });

  it('shows the group columns first, under their column names', async () => {
    const columns = {
      ...line(),
      region: Array.from({ length: 10 }, (_, i) => `<i>r${i}</i>`),
      day: Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2021, 4, 1 + i))),
      amount: Float64Array.from({ length: 10 }, (_, i) => 1000.5 * i)
    };
    const groupby = ['region', 'day', 'amount'];
    const { element, moveTo, rows } = hovered(columns, { x: 'a', y: 'b', r: 3, groupby, key: null, tip: true });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(4);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['region', '<i>r4</i>'], ['day', '2021-05-05'], ['amount', '4,002'], ['a', '40'], ['b', '5']]);
    expect(element.querySelector('.dotgl-tip i')).toBeNull();
  });

  it('shows a group column that is also the fill column once, in the group row with the swatch', async () => {
    const columns = {
      ...line(),
      party: Uint8Array.from({ length: 10 }, (_, i) => i % 2),
      __dotgl_group_0: Array.from({ length: 10 }, (_, i) => ['D', 'R'][i % 2])
    };
    const { element, moveTo, rows } = hovered(columns, { x: 'a', y: 'b', r: 3, fill: 'party', groupby: 'party', key: null, tip: true }, {
      categories: { party: ['D', 'R'] }
    });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['party', 'R'], ['a', '50'], ['b', '5']]);
    const swatches = element.querySelectorAll('.dotgl-tip .dotgl-swatch');
    expect(swatches).toHaveLength(1);
    expect(swatches[0].closest('tr').querySelector('th').textContent).toBe('party');
  });

  it('shows a DATE as a date and a TIMESTAMP with its time, keeping the time at midnight', async () => {
    const columns = {
      ...line(),
      day: Float64Array.from({ length: 10 }, (_, i) => Date.UTC(2021, 4, 1 + i)),
      at: Float64Array.from({ length: 10 }, (_, i) => Date.UTC(2020, 0, 1, 12, i)),
      big: Float64Array.from({ length: 10 }, (_, i) => 12345.678 * i)
    };
    const opts = { types: { x: 'date', y: 'number', fill: 'date' }, sqlTypes: { x: 'DATE', fill: 'TIMESTAMP' } };
    const { moveTo, rows } = hovered(columns, { x: 'day', y: 'big', fill: 'at', tip: true }, opts);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    // The zero seconds and milliseconds are trimmed the way Plot trims them, and no Z: a DuckDB
    // TIMESTAMP says nothing about a time zone.
    expect(rows()).toEqual([['day', '2021-05-06'], ['big', '61,728.39'], ['at', '2020-01-01T12:05']]);
    // Row 0 is exactly midnight. A timestamp column keeps its time there, so every row reads alike.
    moveTo(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['day', '2021-05-01'], ['big', '0'], ['at', '2020-01-01T12:00']]);
  });

  it('shows a TIME as a time of day, and a date-typed r as a date, not a raw number', async () => {
    const columns = {
      ...line(),
      tod: Float64Array.from({ length: 10 }, (_, i) => (9 * 3600 + i * 60) * 1000),
      day: Float64Array.from({ length: 10 }, (_, i) => Date.UTC(2021, 4, 1 + i)),
      big: Float64Array.from({ length: 10 }, (_, i) => 12345.678 * i)
    };
    const opts = { types: { x: 'date', y: 'number', r: 'date' }, sqlTypes: { x: 'TIME', r: 'DATE' } };
    const { moveTo, rows } = hovered(columns, { x: 'tod', y: 'big', r: 'day', tip: true }, opts);
    await vi.advanceTimersByTimeAsync(200);
    moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(rows()).toEqual([['tod', '09:05'], ['big', '61,728.39'], ['day', '2021-05-06']]);
  });

  it('uses a tick format the plot sets, and ignores one that is a format string', async () => {
    const columns = {
      ...line(),
      day: Float64Array.from({ length: 10 }, (_, i) => Date.UTC(2021, 4, 1 + i)),
      big: Float64Array.from({ length: 10 }, (_, i) => 12345.678 * i)
    };
    const opts = { types: { x: 'date', y: 'number' }, sqlTypes: { x: 'DATE' } };
    const shown = attrs => hovered(columns, { x: 'day', y: 'big', tip: true }, { ...opts, attrs });
    // A function is used for both the axis and the tip, so the two read the same.
    const fn = shown({ xTickFormat: d => `day ${d.getUTCDate()}` });
    await vi.advanceTimersByTimeAsync(200);
    fn.moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(fn.rows()[0]).toEqual(['day', 'day 6']);

    // A d3 format string would need a formatting library this package doesn't carry, so it falls through.
    const str = shown({ xTickFormat: '%Y' });
    await vi.advanceTimersByTimeAsync(200);
    str.moveTo(5);
    await vi.advanceTimersByTimeAsync(20);
    expect(str.rows()[0]).toEqual(['day', '2021-05-06']);
  });

  it('shows a time field as a time, converting from the unit its column counts in', async () => {
    const { moveTo, calls, cell } = hovered(line(), { x: 'a', y: 'b', r: 3, tip: { fields: ['tod', 'n'] } });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(3);
    await vi.advanceTimersByTimeAsync(120);
    // 23:54:59 as microseconds, which is how DuckDB hands over a TIME, alongside a plain number.
    calls[0].resolve([{ tod: 86099000000, n: 42 }], [{ typeId: 9, unit: 2 }, { typeId: 8 }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(cell('tod')).toBe('23:54:59');
    expect(cell('n')).toBe('42');
  });

  it('reads a time column that counts in milliseconds just as well', async () => {
    const { moveTo, calls, cell } = hovered(line(), { x: 'a', y: 'b', r: 3, tip: { fields: ['tod'] } });
    await vi.advanceTimersByTimeAsync(200);
    moveTo(3);
    await vi.advanceTimersByTimeAsync(120);
    calls[0].resolve([{ tod: 34215000 }], [{ typeId: 9, unit: 1 }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(cell('tod')).toBe('09:30:15');
  });
});
