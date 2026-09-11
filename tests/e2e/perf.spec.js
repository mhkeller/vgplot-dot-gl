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
  const zoom = await page.evaluate(async () => { await demo.zoomTest(); return document.getElementById('status').textContent; });
  lines.push(zoom);
  testInfo.annotations.push({ type: 'timings', description: lines.join('\n') });
  console.log(`\n[${testInfo.project.name}]\n${lines.join('\n')}`);
  expect(errors).toEqual([]);
});
