import { test, expect } from '@playwright/test';
import { openDemo, panelStats, glRenderer } from './helpers.js';

test('500k rows per plot: renders, refines, and reports timings', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  // Headless Chromium draws in software. Waiting for the "graphics card" there is
  // meaningless and very slow, so only the browsers with a real one wait.
  const benchmark = testInfo.project.name.startsWith('chromium') ? 0 : 1;
  const errors = await openDemo(page, `/?rows=500000&seed=0.42&painter=gl&benchmark=${benchmark}`, { timeout: 600_000 });
  await page.waitForTimeout(1500);
  const panels = await panelStats(page);
  for (const p of panels) {
    expect(p.stats.painter, p.title).toBe('gl');
    expect(p.stats.drawn, p.title).toBe(500000);
  }
  const lines = [`renderer: ${await glRenderer(page)}`];
  lines.push(...panels.map(p => `${p.title}: upload ${p.stats.uploadMs.toFixed(1)} draw ${p.stats.drawMs.toFixed(1)} blit ${p.stats.blitMs.toFixed(1)} dpr ${p.stats.dpr.toFixed(2)}${p.stats.refined ? ' refined' : ''}`));
  // Hover cost per panel: building the pick index from the last paint, and picks at 200 seeded points in the frame.
  // Each point is picked over and over for at least 10 ms and timed together, because Firefox and WebKit round
  // performance.now() to a millisecond on a page that isn't cross-origin isolated.
  const picks = await page.evaluate(() => demo.panels().map(p => {
    const mark = p.plotEl.value.marks[0];
    const paint = mark.lastPaint;
    const t0 = performance.now();
    const index = demo.buildPickIndex(mark, paint);
    const buildMs = performance.now() - t0;
    let s = 42;
    const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const times = [];
    for (let k = 0; k < 200; ++k) {
      const x = rand() * paint.frame.fw;
      const y = rand() * paint.frame.fh;
      const t = performance.now();
      let reps = 0;
      do {
        demo.pickDot(index, x, y, 40);
        ++reps;
      } while (performance.now() - t < 10);
      times.push((performance.now() - t) / reps);
    }
    times.sort((a, b) => a - b);
    return { title: p.spec.title, dots: index.idx.length, buildMs, medianMs: times[100], slowestMs: times[199] };
  }));
  lines.push(...picks.map(p => `${p.title}: pick index ${p.buildMs.toFixed(1)} ms for ${p.dots} dots, pick median ${p.medianMs.toFixed(3)} ms, slowest ${p.slowestMs.toFixed(3)} ms`));
  const zoom = await page.evaluate(async () => { await demo.zoomTest(); return document.getElementById('status').textContent; });
  lines.push(zoom);
  testInfo.annotations.push({ type: 'timings', description: lines.join('\n') });
  console.log(`\n[${testInfo.project.name}]\n${lines.join('\n')}`);
  expect(errors).toEqual([]);
});
