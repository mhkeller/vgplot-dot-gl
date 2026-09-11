import { test, expect } from '@playwright/test';
import { openDemo, panelStats, selfParity, paintedPixels, plotGeometry, settle, rowUnder } from './helpers.js';

test.describe('dotGL core behavior', () => {
  test('renders seven GPU plots with legends and no errors', async ({ page }) => {
    const errors = await openDemo(page);
    const panels = await panelStats(page);
    expect(panels).toHaveLength(7);
    for (const p of panels) {
      expect(p.stats.painter, p.title).toBe('gl');
      expect(p.stats.drawn, p.title).toBe(50000);
      expect(p.hasCanvas, p.title).toBe(true);
    }
    expect(panels.filter(p => p.legend === 1)).toHaveLength(6);
    await expect(page.locator('#status')).toContainText('7 plots ready');
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
    for (let i = 0; i < 7; ++i) {
      const r = await selfParity(page, i);
      expect(r.tested, `panel ${i}`).toBeGreaterThan(150);
      expect(r.hit, `panel ${i}: ${JSON.stringify(r.misses)}`).toBe(r.tested);
    }
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

  test('the hover probe rings the dot under the cursor, centered on it', async ({ page }) => {
    const errors = await openDemo(page);
    for (const panelIndex of [2, 1]) { // constant radius, then sized dots
      const geo = await plotGeometry(page, panelIndex, 1234);
      await page.mouse.move(geo.row.x, geo.row.y);
      await page.waitForTimeout(100);
      await page.mouse.move(geo.row.x + 1, geo.row.y);
      const ring = page.locator('.panel').nth(panelIndex).locator('.ring');
      await expect(ring).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const expected = await rowUnder(page, panelIndex, geo.row.x + 1, geo.row.y);
      const box = await ring.boundingBox();
      const ringCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // The ring is centered on the chosen dot, and the chosen dot is the one covering the mouse.
      expect(Math.hypot(ringCenter.x - expected.x, ringCenter.y - expected.y), `panel ${panelIndex}`).toBeLessThan(1.5);
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
    expect(disposed.refs).toBe(7);
    expect(disposed.glError).toBe(0);
    expect(await paintedPixels(page, 0)).toBe(before);
    expect(errors).toEqual([]);
  });
});
