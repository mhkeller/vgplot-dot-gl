import { test, expect } from '@playwright/test';
import { openDemo, panelStats, selfParity, paintedPixels, plotGeometry, settle, rowUnder } from './helpers.js';

test.describe('dotGL core behavior', () => {
  test('renders nine GPU plots with legends and no errors', async ({ page }) => {
    const errors = await openDemo(page);
    const panels = await panelStats(page);
    expect(panels).toHaveLength(9);
    for (const p of panels) {
      expect(p.stats.painter, p.title).toBe('gl');
      expect(p.stats.drawn, p.title).toBe(50000);
      expect(p.hasCanvas, p.title).toBe(true);
    }
    expect(panels.filter(p => p.legend === 1)).toHaveLength(8);
    await expect(page.locator('#status')).toContainText('9 plots ready');
    // The number-colored panel gets a ramp legend, the category ones get swatches.
    const legends = await page.evaluate(() => demo.panels().map(p => ({ swatches: p.plotEl.querySelectorAll('.legend .swatch, .legend div > div').length > 0, ramp: !!p.plotEl.querySelector('.legend svg image, .legend svg rect') })));
    expect(legends[6].ramp).toBe(true);
    expect(errors).toEqual([]);
  });

  test('dots sit where the SVG dot mark would put them', async ({ page }) => {
    const errors = await openDemo(page);
    await page.click('#compare');
    await page.waitForSelector('#ab[data-ready="1"]');
    const parity = await page.evaluate(() => {
      const [svgPanel, glPanel] = document.querySelectorAll('#ab .panel');
      const svgPlot = svgPanel.querySelector('svg');
      const glPlot = glPanel.querySelector('svg');
      const circles = [...svgPlot.querySelectorAll('circle')];
      const fo = glPlot.querySelector('foreignObject');
      const canvas = fo.firstChild;
      const fx = +fo.getAttribute('x'), fy = +fo.getAttribute('y');
      const scale = canvas.width / +fo.getAttribute('width');
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let tested = 0, hit = 0;
      const step = Math.max(1, Math.floor(circles.length / 400));
      for (let i = 0; i < circles.length; i += step) {
        const c = circles[i];
        const px = Math.round((+c.getAttribute('cx') - fx) * scale);
        const py = Math.round((+c.getAttribute('cy') - fy) * scale);
        if (px < 1 || py < 1 || px >= canvas.width - 1 || py >= canvas.height - 1) continue;
        tested++;
        if (img[(py * canvas.width + px) * 4 + 3] > 0) hit++;
      }
      const same = name => JSON.stringify(svgPlot.scale(name).domain) === JSON.stringify(glPlot.scale(name).domain);
      return { tested, hit, circles: circles.length, sameX: same('x'), sameY: same('y'), sameColor: same('color'), rRange: [svgPlot.scale('r').range, glPlot.scale('r').range] };
    });
    expect(parity.circles).toBe(50000);
    expect(parity.tested).toBeGreaterThan(300);
    expect(parity.hit).toBe(parity.tested);
    expect(parity.sameX && parity.sameY && parity.sameColor).toBe(true);
    expect(parity.rRange[0]).toEqual(parity.rRange[1]);
    expect(errors).toEqual([]);
  });

  test('each panel paints its own rows at the scale positions', async ({ page }) => {
    const errors = await openDemo(page);
    for (let i = 0; i < 9; ++i) {
      const r = await selfParity(page, i);
      expect(r.tested, `panel ${i}`).toBeGreaterThan(150);
      expect(r.hit, `panel ${i}: ${JSON.stringify(r.misses)}`).toBe(r.tested);
    }
    expect(errors).toEqual([]);
  });

  test('draws a text axis and a 601-value text fill, each dot at its category in its color', async ({ page }) => {
    const errors = await openDemo(page);
    // 20 text x values plus null, and a different text fill per row: the fill takes two-byte codes and three palette rows.
    // Seven colors repeat along the 601 categories, so a code read from the wrong palette row or column shows the wrong color.
    // The dots are far enough apart not to overlap, so the pixel at each center has that dot's own color.
    await page.evaluate(async () => {
      const { vg, dotGL } = demo;
      await vg.coordinator().exec(`CREATE OR REPLACE TABLE cat_grid AS
        SELECT 'x' || lpad((i % 20)::VARCHAR, 2, '0') AS gx, (i // 20)::DOUBLE AS gy, 'f' || lpad(i::VARCHAR, 3, '0') AS name FROM range(600) t(i)
        UNION ALL SELECT NULL, 30, NULL`);
      const colors = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf'];
      window.catGrid = vg.plot(dotGL(vg.from('cat_grid'), { x: 'gx', y: 'gy', fill: 'name', r: 2 }), vg.colorRange(colors), vg.width(430), vg.height(330));
      document.body.append(window.catGrid);
    });
    await page.waitForFunction(() => !!catGrid.value.marks[0].stats && !catGrid.value.pendingRender, null, { timeout: 20_000 });
    const r = await page.evaluate(() => {
      const mark = catGrid.value.marks[0];
      const svg = catGrid.querySelector('svg');
      const xs = svg.scale('x'), ys = svg.scale('y'), cs = svg.scale('color');
      const fo = svg.querySelector('foreignObject');
      const canvas = fo.firstChild;
      const scale = canvas.width / +fo.getAttribute('width');
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const column = name => mark.data.columns[mark.channelField(name, { exact: true }).as];
      const [X, Y, F] = [column('x'), column('y'), column('fill')];
      const { xCats, cats } = mark.prep;
      let bad = 0;
      const misses = [];
      for (let i = 0; i < X.length; ++i) {
        const px = Math.round((xs.apply(xCats[X[i]]) - +fo.getAttribute('x')) * scale);
        const py = Math.round((ys.apply(Y[i]) - +fo.getAttribute('y')) * scale);
        const want = cs.apply(cats[F[i]]);
        const k = (py * canvas.width + px) * 4;
        const got = Array.from(img.subarray(k, k + 4));
        const ok = got[3] === 255 && [1, 3, 5].every((j, c) => Math.abs(parseInt(want.slice(j, j + 2), 16) - got[c]) <= 3);
        if (ok) continue;
        ++bad;
        if (misses.length < 5) misses.push({ i, x: xCats[X[i]], fill: cats[F[i]], want, got });
      }
      return { rows: X.length, drawn: mark.stats.drawn, painter: mark.stats.painter, xType: xs.type, arrays: [X.constructor.name, F.constructor.name], bad, misses };
    });
    expect(r, JSON.stringify(r.misses)).toMatchObject({ rows: 601, drawn: 601, painter: 'gl', xType: 'point', arrays: ['Uint8Array', 'Uint16Array'], bad: 0 });
    expect(errors).toEqual([]);
  });

  test('wheel zoom re-renders and keeps dots aligned with the axes', async ({ page }) => {
    const errors = await openDemo(page);
    const before = await plotGeometry(page, 0, 0);
    await page.mouse.move(before.center.x, before.center.y);
    for (let i = 0; i < 12; ++i) {
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(40);
    }
    await settle(page, 0);
    const after = await plotGeometry(page, 0, 0);
    expect(after.xDomain).not.toEqual(before.xDomain);
    expect(after.xDomain[1] - after.xDomain[0]).toBeLessThan(before.xDomain[1] - before.xDomain[0]);
    const parity = await selfParity(page, 0);
    expect(parity.tested).toBeGreaterThan(30);
    expect(parity.hit, JSON.stringify(parity.misses)).toBe(parity.tested);
    expect(errors).toEqual([]);
  });

  test('brushing one panel filters the linked panel', async ({ page }) => {
    const errors = await openDemo(page);
    const overlay = page.locator('.panel').nth(4).locator('rect.overlay');
    const box = await overlay.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await panelStats(page))[5].stats.drawn, { timeout: 20_000 }).toBeLessThan(50000);
    // The brush fires again on release; let the linked panel finish its last query and redraw.
    await settle(page, 5);
    const filtered = (await panelStats(page))[5].stats.drawn;
    expect(filtered).toBeGreaterThan(0);
    const parity = await selfParity(page, 5);
    expect(parity.hit).toBe(parity.tested);
    expect(errors).toEqual([]);
  });

  test('the tooltip rings the dot under the cursor and shows its id', async ({ page }) => {
    const errors = await openDemo(page);
    // Constant radius, then sized dots, then constant radius in a container narrow enough to shrink the SVG.
    for (const [panelIndex, narrow] of [[2, false], [1, false], [2, true]]) {
      const panel = page.locator('.panel').nth(panelIndex);
      if (narrow) await panel.locator('.host').evaluate(el => { el.style.width = '300px'; });
      const ring = panel.locator('.dotgl-ring');
      const tip = panel.locator('.dotgl-tip');
      const geo = await plotGeometry(page, panelIndex, 1234);
      // Whole pixels, because Firefox rounds mouse positions down and the pick would land on a different dot.
      const at = { x: Math.round(geo.row.x) + 1, y: Math.round(geo.row.y) };
      await page.mouse.move(at.x - 1, at.y);
      await page.waitForTimeout(100);
      await page.mouse.move(at.x, at.y);
      await expect(ring).toBeVisible({ timeout: 10_000 });
      await expect(tip).toBeVisible();
      // Let the second move's pick land.
      await page.waitForTimeout(300);
      /** The ring is centered on the dot the rule picks at the pointer. Returns that dot. */
      const ringOnPick = async () => {
        const expected = await rowUnder(page, panelIndex, at.x, at.y);
        expect(expected, `panel ${panelIndex}`).not.toBeNull();
        const box = await ring.boundingBox();
        expect(Math.hypot(box.x + box.width / 2 - expected.x, box.y + box.height / 2 - expected.y), `panel ${panelIndex}`).toBeLessThan(1.5);
        return expected;
      };
      const expected = await ringOnPick();
      if (narrow) {
        const shrink = await page.evaluate(index => { const svg = demo.panels()[index].plotEl.querySelector('svg'); return svg.getBoundingClientRect().width / +svg.getAttribute('width'); }, panelIndex);
        expect(shrink).toBeLessThan(0.9);
      }
      // The id comes from the lookup by key once the pointer rests; it may be formatted with thousands separators.
      const key = await page.evaluate(([index, row]) => demo.panels()[index].plotEl.value.marks[0].data.columns.__dotgl_key[row], [panelIndex, expected.row]);
      const idCell = tip.locator('tr', { has: page.locator('th', { hasText: /^id$/ }) }).locator('td');
      await expect.poll(async () => (await idCell.allTextContents()).join('').replace(/,/g, ''), { timeout: 10_000 }).toBe(String(key));
      // A zoom step redraws the plot. The pointer stays put, so the ring comes back in the new SVG on the dot now under it.
      await page.evaluate(index => { window.svgBeforeZoom = demo.panels()[index].plotEl.querySelector('svg'); }, panelIndex);
      await page.mouse.wheel(0, -40);
      await expect.poll(() => page.evaluate(index => {
        const svg = demo.panels()[index].plotEl.querySelector('svg');
        return svg !== window.svgBeforeZoom && !!svg.querySelector('.dotgl-ring');
      }, panelIndex), { timeout: 10_000 }).toBe(true);
      await settle(page, panelIndex);
      await expect(ring).toBeVisible({ timeout: 10_000 });
      await ringOnPick();
    }
    expect(errors).toEqual([]);
  });

  test('recovers from context loss and from disposing the shared context', async ({ page }) => {
    const errors = await openDemo(page);
    const before = await paintedPixels(page, 0);
    expect(before).toBeGreaterThan(1000);
    const lost = await page.evaluate(async () => {
      const s = demo.getSharedGL();
      const ext = s.gl.getExtension('WEBGL_lose_context');
      if (!ext) return 'no extension';
      ext.loseContext();
      await new Promise(r => setTimeout(r, 300));
      const wasLost = s.lost;
      ext.restoreContext();
      await new Promise(r => setTimeout(r, 2000));
      return { wasLost, lostNow: s.lost, refs: s.refs.size };
    });
    if (lost !== 'no extension') {
      expect(lost.wasLost).toBe(true);
      expect(lost.lostNow).toBe(false);
      expect(await paintedPixels(page, 0)).toBe(before);
    }
    const disposed = await page.evaluate(async () => {
      demo.disposeSharedGL();
      for (const p of demo.panels()) p.plotEl.value.update();
      await new Promise(r => setTimeout(r, 1500));
      const s = demo.getSharedGL();
      return { refs: s.refs.size, glError: s.gl.getError() };
    });
    expect(disposed.refs).toBe(9);
    expect(disposed.glError).toBe(0);
    expect(await paintedPixels(page, 0)).toBe(before);
    expect(errors).toEqual([]);
  });
});
