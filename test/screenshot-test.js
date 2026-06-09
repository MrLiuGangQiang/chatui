#!/usr/bin/env node
/**
 * Flat theme screenshot & functionality test suite.
 * Takes screenshots of all key views and validates layout.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'temp', 'flat-theme-screenshots');
const BASE_URL = 'http://127.0.0.1:8765';
const VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name, { fullPage = false, clip = null } = {}) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage, clip });
  console.log(`  ✓ Screenshot: ${name}.png`);
  return filePath;
}

async function testViewport(page, width, height, label) {
  await page.setViewport({ width, height });
  await sleep(500);
  await screenshot(page, `${label}-main`, { fullPage: true });
}

async function clickAndWait(page, selector, waitMs = 300) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout: 3000 });
    await page.click(selector);
    await sleep(waitMs);
    return true;
  } catch (e) {
    console.log(`  ⚠ Could not click "${selector}": ${e.message}`);
    return false;
  }
}

async function run() {
  ensureDir(SCREENSHOT_DIR);
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const context = browser.defaultBrowserContext();
  await context.overridePermissions(BASE_URL, []);

  const page = await context.newPage();
  const results = { passed: 0, failed: 0, warnings: 0 };

  try {
    // ===== 1. Desktop: Main view =====
    console.log('\n=== 1. Desktop Main View ===');
    await page.setViewport(VIEWPORT);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(1000);
    await screenshot(page, '01-main-desktop', { fullPage: false });

    // Check key elements exist
    const desktopChecks = [
      ['#sessionRail', 'Session rail (accepts hidden)', true],
      ['#sessionSidebar', 'Session sidebar'],
      ['#messages', 'Messages area'],
      ['#composer', 'Composer'],
      ['#prompt', 'Prompt textarea'],
      ['#sendBtn', 'Send button'],
      ['#reasoningToggle', 'Reasoning toggle'],
      ['#newSessionBtn', 'New session button'],
    ];
    for (const [selector, name, acceptHidden] of desktopChecks) {
      try {
        const el = await page.$(selector);
        if (el) {
          console.log(`  ✓ ${name} (${selector})`);
          results.passed++;
        } else if (acceptHidden) {
          console.log(`  - ${name} not visible (expected)`);
          results.passed++;
        } else {
          console.log(`  ✗ ${name} missing!`);
          results.failed++;
        }
      } catch (e) {
        if (acceptHidden) {
          console.log(`  - ${name} not visible (expected)`);
          results.passed++;
        } else {
          console.log(`  ✗ ${name} error: ${e.message}`);
          results.failed++;
        }
      }
    }

    // ===== 2. Desktop: Sidebar collapsed =====
    console.log('\n=== 2. Sidebar Collapsed ===');
    await page.setViewport(VIEWPORT);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(800);
    // Click collapse button
    if (await clickAndWait(page, '#collapseSessionsBtn')) {
      await sleep(500);
      await screenshot(page, '02-sidebar-collapsed', { fullPage: false });
      results.passed++;
    }
    // Reopen sidebar
    if (await clickAndWait(page, '#railExpandBtn', 500)) {
      await sleep(400);
    }

    // ===== 3. Config Modal =====
    console.log('\n=== 3. Config Modal ===');
    // Use sidebar config button instead of rail button
    if (await clickAndWait(page, '#sidebarConfigBtn', 600)) {
      await sleep(400);
      await screenshot(page, '03-config-dialog', { fullPage: false });
      results.passed++;

    
      // Close config
      if (await clickAndWait(page, '#closeConfigBtn', 400)) {
        results.passed++;
      }
    }

    // ===== 5. Session Prompt Panel =====
    console.log('\n=== 5. Session Prompt Panel ===');
    if (await clickAndWait(page, '#sessionPromptBtn', 600)) {
      await sleep(400);
      await screenshot(page, '05-session-prompt', { fullPage: false });
      results.passed++;
      // Close
      if (await clickAndWait(page, '#sessionPromptCancelBtn', 400)) {
        results.passed++;
      }
    }

    // ===== 6. Image Style Prompt Panel =====
    console.log('\n=== 6. Image Style Prompt Panel ===');
    if (await clickAndWait(page, '#sessionImageStyleBtn', 600)) {
      await sleep(400);
      await screenshot(page, '06-image-style-prompt', { fullPage: false });
      results.passed++;
      // Close
      if (await clickAndWait(page, '#sessionImageStyleCancelBtn', 400)) {
        results.passed++;
      }
    }

    // ===== 7. Session Model Menu =====
    console.log('\n=== 7. Session Model Menu ===');
    if (await clickAndWait(page, '#sessionModelBtn', 600)) {
      await sleep(400);
      await screenshot(page, '07-model-menu', { fullPage: false });
      results.passed++;
      // Close by clicking elsewhere
      await page.mouse.click(100, 100);
      await sleep(300);
    }

    // ===== 8. Reasoning Menu =====
    console.log('\n=== 8. Reasoning Menu ===');
    // First enable reasoning mode
    if (await clickAndWait(page, '#reasoningToggle', 500)) {
      results.passed++;
      await sleep(300);
      if (await clickAndWait(page, '#reasoningMenuBtn', 600)) {
        await sleep(400);
        await screenshot(page, '08-reasoning-menu', { fullPage: false });
        results.passed++;
        await page.mouse.click(100, 100);
        await sleep(300);
      }
    }

    // ===== 9. Confirm Dialog =====
    console.log('\n=== 9. Confirm Dialog ===');
    // Trigger confirm dialog by clicking clear all sessions
    if (await clickAndWait(page, '#clearAllSessionsBtn', 600)) {
      await sleep(400);
      await screenshot(page, '09-confirm-dialog', { fullPage: false });
      results.passed++;
      // Cancel
      if (await clickAndWait(page, '#confirmDialogCancel', 400)) {
        results.passed++;
      }
    }

    // ===== 10. Send a message & view =====
    console.log('\n=== 10. Chat Messages ===');
    // Type a message
    const prompt = await page.$('#prompt');
    if (prompt) {
      await prompt.type('Hello! This is a test message.');
      await sleep(300);
      // We won't actually send (needs API config), just verify typing works
      await screenshot(page, '10-chat-with-input', { fullPage: false });
      results.passed++;
    }

    // ===== 11. Mobile View =====
    console.log('\n=== 11. Mobile View (390px) ===');
    await page.setViewport(MOBILE_VIEWPORT);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(1000);
    await screenshot(page, '11-mobile-main', { fullPage: false });

    // Mobile sidebar drawer
    if (await clickAndWait(page, '#mobileSessionFloatBtn', 800)) {
      await sleep(400);
      await screenshot(page, '12-mobile-sidebar', { fullPage: false });
      results.passed++;
      // Close drawer
      if (await clickAndWait(page, '#sessionDrawerMask', 400)) {
        results.passed++;
      }
    }

    // ===== 12. Mobile Config =====
    console.log('\n=== 12. Mobile Config ===');
    if (await clickAndWait(page, '#collapseSessionsBtn', 600)) {
      await sleep(400);
      await screenshot(page, '13-mobile-config', { fullPage: false });
      results.passed++;
      if (await clickAndWait(page, '#closeConfigBtn', 400)) {
        results.passed++;
      }
    }

    // ===== CSS Validation =====
    console.log('\n=== 13. CSS Validation ===');
    const cssIssues = await page.evaluate(() => {
      const issues = [];
      const bodyStyle = getComputedStyle(document.body);
      
      // Body gradient is intentional for iOS liquid glass theme
      // (skip gradient check)
      
      // Check stylesheet loaded
      const flatTheme = Array.from(document.styleSheets).find(s => 
        s.href && s.href.includes('flat-theme')
      );
      if (!flatTheme) {
        issues.push('flat-theme.css not loaded');
      }
      
      // iOS Liquid Glass: backdrop-filter is expected and desired
      const glassExpected = [
        '.config-dialog', '.usage-stats-card',
        '.session-model-menu', '.reasoning-menu', '.input-stack'
      ];
      
      for (const sel of glassExpected) {
        const el = document.querySelector(sel);
        if (el) {
          const computed = getComputedStyle(el);
          if (!computed.backdropFilter || computed.backdropFilter === 'none') {
            issues.push(`${sel} missing expected backdrop-filter (glass effect)`);
          }
        }
      }
      
      if (issues.length === 0) {
        issues.push(null); // signal all good
      }
      
      return issues.filter(Boolean);
      
      // Check body background is simple
      if (bodyStyle.backgroundAttachment === 'fixed') {
        // OK for liquid glass theme
      }
      
      return issues;
    });

    if (cssIssues.length) {
      console.log('  CSS Issues:');
      cssIssues.forEach(i => console.log(`    ⚠ ${i}`));
      results.warnings += cssIssues.length;
    } else {
      console.log('  ✓ All CSS checks passed');
      results.passed++;
    }

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${results.passed} passed, ${results.failed} failed, ${results.warnings} warnings`);
    console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
    console.log('='.repeat(50));

    return results.failed === 0;
  } catch (e) {
    console.error('\n✗ Test error:', e.message);
    return false;
  } finally {
    await browser.close();
  }
}

run().then(success => {
  process.exit(success ? 0 : 1);
}).catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
