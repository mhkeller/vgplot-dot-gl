import { Query, column, eq, literal } from '@uwdata/mosaic-sql';
import { buildPickIndex, pickDot } from './pick.js';

/** The name the key column comes back under in the mark's data. */
export const KEY_AS = '__dotgl_key';

/** A paint this new doesn't get a pick index yet, so moving the pointer during a wheel zoom builds none. */
const QUIET_MS = 150;

/** How long the pointer rests on a dot before its extra fields are looked up. */
const REST_MS = 100;

const SVG = 'http://www.w3.org/2000/svg';
const NUMBER = new Intl.NumberFormat('en-US');
const NO_FIELDS = [];

/** Default looks. `:where()` gives them no specificity, so any page CSS wins. */
const STYLE = `
:where(.dotgl-tip) { z-index: 10; pointer-events: none; background: #fff; color: #222; border: 1px solid #ccc; border-radius: 3px; padding: 4px 6px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
:where(.dotgl-tip th) { color: #555; font-weight: normal; text-align: left; padding: 0 8px 0 0; }
:where(.dotgl-tip td) { padding: 0; }
:where(.dotgl-swatch) { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 2px; }
`;

/** A value as tooltip text. Dates (Date objects, or epoch milliseconds when `date` is set) show as ISO, without the time at UTC midnight. */
function format(value, date) {
  if (value instanceof Date || (date && typeof value === 'number')) {
    if (!Number.isFinite(+value)) return '';
    const iso = new Date(+value).toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'number') return Number.isNaN(value) ? '' : NUMBER.format(value);
  return value == null ? '' : String(value);
}

/**
 * The tooltip of a DotGLMark, added to its plot as a Mosaic interactor. It finds the
 * dot under the pointer in what the mark last painted, rings it, and shows its group
 * columns, x, y, fill and r next to it. Extra fields are looked up by key, one row at a time, once
 * the pointer rests, and kept in `mark.tipRows`.
 */
export class DotGLTip {
  constructor(mark, { fields = null, maxRadius = 40 } = {}) {
    this.mark = mark;
    this.fields = fields;
    this.maxRadius = maxRadius;
    /** Columns the tip shows from the mark's own data. Extra fields with these names are left out. */
    this.names = ['x', 'y', 'fill', 'r'].map(name => mark.channelField(name, { exact: true })?.as).filter(Boolean);
    this.svg = null;
    this.index = null;
    this.ring = null;
    this.tip = null;
    /** The pick on screen, and its key when it has extra fields. */
    this.shown = null;
    this.shownId = null;
    /** The key whose extra fields are looked up next. */
    this.wanted = null;
    /** The field list `mark.tipRows` was filled for, and the fields in it the tip looks up. */
    this.fieldsFor = null;
    this.extras = NO_FIELDS;
    this.clientX = 0;
    this.clientY = 0;
    /** Whether the pointer is over the plot with no button held. */
    this.over = false;
    this.raf = 0;
    /** What the first tip does when the pointer leaves the plot. */
    this.leave = null;
    this.quietTimer = null;
    this.restTimer = null;
    this.busy = false;
    this.warned = false;
  }

  /**
   * Mosaic calls this on every interactor with each new SVG, before it replaces the old one. The plot's
   * first DotGLTip listens to the pointer and picks for all of them, so the plot shows one tip at a time.
   */
  init(svg) {
    this.hide();
    this.svg = svg;
    const tips = this.mark.plot.interactors.filter(i => i instanceof DotGLTip);
    if (tips[0] !== this) return;
    const el = this.mark.plot.element;
    // A redraw comes with no pointer event, so a pointer still over the plot is picked again from the new paint.
    // A plot taken out of the page and put back hears no leave, so `:hover` confirms the pointer is still there.
    if (this.over && el.matches(':hover')) this.raf ||= requestAnimationFrame(() => this.update(tips));
    svg.addEventListener('pointermove', e => {
      this.over = !e.buttons;
      if (e.buttons) return this.stop(tips);
      this.clientX = e.clientX;
      this.clientY = e.clientY;
      this.raf ||= requestAnimationFrame(() => this.update(tips));
    });
    // A pointer that leaves right after a redraw gets no leave event from the new SVG, which it never entered, so the plot element that holds every SVG listens too.
    if (!this.leave) {
      this.leave = () => {
        this.over = false;
        this.stop(tips);
        for (const tip of tips) tip.index = null;
      };
      el.addEventListener('pointerleave', this.leave);
    }
    svg.addEventListener('pointerleave', this.leave);
  }

  /** Hides every tip on the plot and drops the pick waiting to run. */
  stop(tips) {
    for (const tip of tips) tip.hide();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.quietTimer);
    this.raf = 0;
  }

  /** Picks the dot under the last pointer position in each tip's mark and shows the closest. On a tie the later mark, drawn on top, wins. */
  update(tips) {
    this.raf = 0;
    const at = new DOMPoint(this.clientX, this.clientY).matrixTransform(this.svg.getScreenCTM().inverse());
    let best = null;
    let owner = null;
    for (const tip of tips) {
      const { mark } = tip;
      const paint = mark.lastPaint;
      if (mark.destroyed || !paint || paint.prep !== mark.prep) continue;
      if (tip.index?.paint !== paint) {
        const wait = QUIET_MS - (performance.now() - paint.at);
        if (wait > 0) {
          clearTimeout(this.quietTimer);
          this.quietTimer = setTimeout(() => this.update(tips), wait);
          return;
        }
        tip.index = buildPickIndex(mark, paint);
      }
      const hit = pickDot(tip.index, at.x - paint.frame.fx, at.y - paint.frame.fy, tip.maxRadius);
      if (hit && (!best || hit.key <= best.key)) {
        best = hit;
        owner = tip;
      }
    }
    for (const tip of tips) if (tip !== owner) tip.hide();
    if (owner && best.j !== owner.shown?.j) owner.show(best);
  }

  /** Rings the picked dot, shows its tip, and starts the rest timer for its extra fields when they aren't known yet. */
  show(hit) {
    const { mark, svg } = this;
    const { frame } = this.index.paint;
    const doc = svg.ownerDocument;
    this.hide();
    this.shown = hit;

    if (!this.ring) {
      this.ring = doc.createElementNS(SVG, 'circle');
      this.ring.setAttribute('class', 'dotgl-ring');
      this.ring.setAttribute('pointer-events', 'none');
      this.ring.setAttribute('fill', 'none');
      this.ring.setAttribute('stroke', 'currentColor');
      this.tip = doc.createElement('div');
      this.tip.className = 'dotgl-tip';
      this.tip.setAttribute('aria-hidden', 'true');
      if (!doc.head.querySelector('style[data-dotgl-tip]')) {
        const style = doc.head.appendChild(doc.createElement('style'));
        style.dataset.dotglTip = '';
        style.textContent = STYLE;
      }
    }
    this.ring.setAttribute('cx', hit.px + frame.fx);
    this.ring.setAttribute('cy', hit.py + frame.fy);
    this.ring.setAttribute('r', hit.r + 2);
    svg.appendChild(this.ring);

    // Fields are read now, so the page can change a Param holding them without rebuilding the plot.
    const list = Array.isArray(this.fields) ? this.fields : this.fields?.value ?? NO_FIELDS;
    if (list !== this.fieldsFor) {
      mark.tipRows = new Map();
      this.fieldsFor = list;
      this.extras = list.filter(name => !this.names.includes(name));
    }
    if (this.extras.length) {
      const id = mark.data.columns[KEY_AS][hit.j];
      this.shownId = id;
      // The row becomes wanted only once the pointer rests, so a lookup that finishes mid-sweep doesn't
      // start one for the row the pointer is passing. A row without a key is never looked up.
      if (!mark.tipRows.has(id)) {
        this.restTimer = setTimeout(() => {
          this.wanted = id;
          this.fetch();
        }, REST_MS);
      }
    }
    this.draw();
  }

  /** Fills the tip with the shown dot's values and places it next to the dot. Extra fields not looked up yet show '…'. */
  draw() {
    const { mark, svg, tip, shown: { j, px, py, r } } = this;
    const { frame, prep, style, labels } = this.index.paint;
    const doc = tip.ownerDocument;
    const table = doc.createElement('table');
    // Values are user data, so they only ever go in as text.
    const row = (label, text, color) => {
      const tr = table.appendChild(doc.createElement('tr'));
      tr.appendChild(doc.createElement('th')).textContent = label;
      const td = tr.appendChild(doc.createElement('td'));
      if (color) {
        const swatch = td.appendChild(doc.createElement('span'));
        swatch.className = 'dotgl-swatch';
        swatch.style.background = color;
      }
      td.append(text);
    };
    const channel = name => mark.channelField(name, { exact: true });
    const value = name => mark.data.columns[channel(name).as][j];
    const fill = channel('fill');
    const code = prep.codes[j];
    const p = style.palette;
    const color = fill && `rgba(${p[code * 4]}, ${p[code * 4 + 1]}, ${p[code * 4 + 2]}, ${p[code * 4 + 3] / 255})`;
    // A group column that is also the fill column shows once, as that group's row with the swatch.
    const fillGroup = fill && mark.groups.find(g => g.name === fill.field.column);
    // The group columns come first: they say which group the dot is.
    for (const group of mark.groups) row(group.name, format(mark.data.columns[group.as][j]), group === fillGroup && color);
    for (const name of ['x', 'y']) {
      const cats = prep[`${name}Cats`];
      row(labels[name] ?? channel(name).as, format(cats ? cats[value(name)] : value(name), prep.dates[name]));
    }
    if (fill && !fillGroup) {
      row(fill.as, prep.continuous ? format(value('fill'), prep.dates.fill) : format(prep.cats[code]), color);
    }
    if (channel('r')) row(channel('r').as, format(value('r')));
    const pending = this.shownId != null && !mark.tipRows.has(this.shownId);
    const extra = mark.tipRows.get(this.shownId);
    for (const name of this.extras) row(name, pending ? '…' : format(extra?.[name]));
    tip.replaceChildren(table);

    // Right of the dot, or left of it when there is no room; kept inside the plot element vertically.
    const el = mark.plot.element;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    tip.style.cssText = 'position:absolute;left:0;top:0';
    el.appendChild(tip);
    const ctm = svg.getScreenCTM();
    const box = el.getBoundingClientRect();
    const rightOf = new DOMPoint(px + frame.fx + r + 6, py + frame.fy).matrixTransform(ctm);
    let left = rightOf.x - box.left;
    if (left + tip.offsetWidth > el.clientWidth) {
      left = new DOMPoint(px + frame.fx - r - 6, 0).matrixTransform(ctm).x - box.left - tip.offsetWidth;
    }
    const top = Math.max(0, Math.min(rightOf.y - box.top - tip.offsetHeight / 2, el.clientHeight - tip.offsetHeight));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  hide() {
    this.ring?.remove();
    this.tip?.remove();
    this.shown = null;
    this.shownId = null;
    this.wanted = null;
    clearTimeout(this.restTimer);
  }

  /** Looks up the extra fields of the wanted row, one query at a time, until the wanted row is known. */
  async fetch() {
    if (this.busy) return;
    this.busy = true;
    const { mark } = this;
    try {
      while (this.wanted != null && mark.coordinator && !mark.tipRows.has(this.wanted)) {
        const id = this.wanted;
        const rows = mark.tipRows;
        const fields = this.fieldsFor;
        const select = Object.fromEntries(fields.map(name => [name, column(name)]));
        const query = Query.from({ source: mark.sourceTable() })
          .select(select)
          .where(eq(mark.key, literal(id)))
          .limit(1);
        const table = await mark.coordinator.query(query, { cache: false });
        // Columns are read in select order: DuckDB names a column the way the table spells it, which can differ in case from the field.
        // Each value is read on its own, so one that can't be read (a 64-bit integer past 2^53) leaves only its own cell empty.
        const read = k => {
          const child = table.getChildAt(k);
          try {
            return child.at(0);
          } catch {
            return null;
          }
        };
        rows.set(id, table.numRows ? Object.fromEntries(Object.keys(select).map((name, k) => [name, read(k)])) : null);
        // Skip the redraw when the table, the fields or the painted dots changed while the query ran.
        if (rows === mark.tipRows && this.shownId === id && mark.lastPaint === this.index?.paint) this.draw();
      }
    } catch (err) {
      if (!this.warned) console.warn(`dotGL: tooltip fields lookup failed: ${err?.message ?? err}`);
      this.warned = true;
    } finally {
      this.busy = false;
    }
  }
}
