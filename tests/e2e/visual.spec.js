import { test, expect } from '@playwright/test';
import { openDemo } from './helpers.js';

const mask = page => [page.locator('.stats'), page.locator('#status')];

test.describe('screenshots', () => {
  test('seven panels at 50k rows', async ({ page }) => {
    const errors = await openDemo(page);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('demo-50k.png', { mask: mask(page), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('narrow layout shrinks the SVG and the canvas with it', async ({ page }) => {
    const errors = await openDemo(page);
    // Plot gives its SVG max-width:100%, so a narrow container shrinks the whole drawing.
    await page.evaluate(() => { document.querySelector('.panel .host').style.width = '300px'; });
    await page.waitForTimeout(300);
    const first = page.locator('.panel').first();
    await expect(first).toHaveScreenshot('panel-narrow.png', { mask: mask(page) });
    const shrink = await first.evaluate(el => {
      const svg = el.querySelector('svg');
      const canvas = el.querySelector('foreignObject canvas');
      return { svgWidth: svg.getBoundingClientRect().width, attrWidth: +svg.getAttribute('width'), canvasCss: canvas.getBoundingClientRect().width, canvasAttr: +canvas.parentElement.getAttribute('width') };
    });
    expect(shrink.svgWidth).toBeLessThan(shrink.attrWidth);
    // The canvas shrinks by the same factor as the SVG around it.
    expect(shrink.canvasCss / shrink.canvasAttr).toBeCloseTo(shrink.svgWidth / shrink.attrWidth, 2);
    expect(errors).toEqual([]);
  });

  test('A/B panels look the same', async ({ page }) => {
    const errors = await openDemo(page);
    await page.click('#compare');
    await page.waitForSelector('#ab[data-ready="1"]');
    await page.waitForTimeout(300);
    await expect(page.locator('#ab')).toHaveScreenshot('ab-50k.png', { mask: mask(page) });
    expect(errors).toEqual([]);
  });
});
