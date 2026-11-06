import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startMockApi, type MockApi } from './mock-api';

// Set E2E_SHOTS to save elsewhere: sync tools such as OneDrive can lock files in the repo folder.
const SHOTS =
  process.env.E2E_SHOTS ??
  fileURLToPath(new URL('../../../docs/ui-revamp/screenshots/after/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
let api: MockApi;

test.beforeAll(async () => {
  api = await startMockApi(3901);
});
test.afterAll(async () => api.close());

async function open(page: Page, path = '/app') {
  await page.addInitScript(() =>
    localStorage.setItem(
      'warden.session',
      JSON.stringify({ token: 'mock', expiresAt: new Date(Date.now() + 864e5).toISOString() }),
    ),
  );
  await page.goto(path);
}

async function ask(page: Page, text: string) {
  const box = page.getByLabel('Message your agent').locator('textarea');
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await box.press('Enter');
}

test('the workspace puts the agent and the portfolio first', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: /What should SAKA do next/ })).toBeVisible();
  await expect(page.getByText('Portfolio value')).toBeVisible();
  await expect(page.getByText('waiting for you').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}workspace.png` });
  await page.getByRole('link', { name: /Portfolio value/ }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
});

test('the landing page reacts to the cursor, and Start enters the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /DeFi that thinks/ })).toBeVisible();
  await expect(page.getByText('Testnet only')).toBeVisible();
  const lit = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas')!;
      const { data } = c
        .getContext('2d')!
        .getImageData(c.width / 2 - 150, c.height / 2 - 150, 300, 300);
      let sum = 0;
      for (let i = 3; i < data.length; i += 4) sum += data[i]!;
      return sum;
    });
  await page.waitForTimeout(600);
  const before = await lit();
  const size = page.viewportSize()!;
  for (let i = 0; i < 40; i += 1) {
    const a = i / 4;
    await page.mouse.move(size.width / 2 + Math.cos(a) * 110, size.height / 2 + Math.sin(a) * 110);
    await page.waitForTimeout(25);
  }
  expect(await lit()).not.toBe(before);
  await page.screenshot({ path: `${SHOTS}landing.png` });
  await page.getByRole('link', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('reduced motion: the landing page holds one still frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Start' })).toBeVisible();
  const pixels = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas')!;
      return c.toDataURL().length;
    });
  const first = await pixels();
  await page.waitForTimeout(500);
  expect(await pixels()).toBe(first);
});

test('"swap $5" → preview with countdown → receipt in place with 0G proof', async ({ page }) => {
  await open(page, '/app');
  await expect(page.getByRole('heading', { name: /What should SAKA do next/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}ask-empty.png` });
  await ask(page, 'Swap $5 ETH to USDC');
  const preview = page.getByLabel('Action preview');
  await expect(preview.getByText(/Agent will do this in/)).toBeVisible();
  await expect(preview.getByText('0G guard approved · p=0.96')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}preview-countdown.png` });
  const receipt = page.getByLabel('Receipt');
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Action preview')).toHaveCount(0); // transitioned in place
  await expect(receipt.getByText('0G Storage')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}receipt.png` });
  await receipt.getByRole('button', { name: /Details/ }).click();
  await expect(page.getByRole('dialog').getByText('Timeline')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('0x3593564c')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}plan-drawer.png` });
});

test('"swap $60" → approval → Reject → denied, nothing traded', async ({ page }) => {
  await open(page, '/app');
  await ask(page, 'Swap $60 ETH to USDC');
  const card = page.getByLabel('Approval needed').last();
  await expect(card.getByText('60 / max 25')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('button', { name: /Approve \(dev\)/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}approval.png` });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByText('You rejected it. Nothing was traded.')).toBeVisible({
    timeout: 10_000,
  });
});

test('refusal card renders the suggestion chip and it pre-fills the composer', async ({ page }) => {
  await open(page, '/app');
  await ask(page, 'Swap $500 ETH to USDC');
  const card = page.getByLabel('Refused').last();
  await expect(card.getByText('7.2 / max 5')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}refusal.png` });
  await card.getByRole('button', { name: 'Try instead: Swap $250 ETH to USDC' }).click();
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Swap $250 ETH to USDC',
  );
});

test('activity, autopilot, tablet and 375px mobile layouts', async ({ page }) => {
  await open(page, '/app');
  await ask(page, 'Is USDC safe?');
  await expect(page.getByText('Looks safe', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}ask-desktop.png` });
  await page.goto('/activity');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'When it said no' }).click();
  await expect(page.getByRole('table').getByText('Refused').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}activity.png` });
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/autopilot$/);
  await expect(page.getByText('Needs your approval')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Open live activity' }).click();
  await expect(
    page.getByRole('dialog').getByRole('toolbar', { name: 'Filter activity' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Live activity')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}home-tablet.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/app');
  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(tabs.getByRole('link', { name: 'Agent' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}home-mobile.png` });
  await tabs.getByRole('link', { name: 'Activity' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await page.screenshot({ path: `${SHOTS}activity-mobile.png` });
});

test('hooks explorer: cards with scores and plain words, detail page with breakdown', async ({
  page,
}) => {
  await open(page, '/hooks');
  await expect(page.getByLabel('Safety score 25 of 100, Danger')).toBeVisible();
  await expect(page.getByText('Can change your swap amount').first()).toBeVisible();
  await page.getByRole('button', { name: 'Safe', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}hooks.png` });
  await page.getByRole('link', { name: 'DynamicFeeHook' }).click();
  await expect(page.getByText('return delta permissions')).toBeVisible();
  await expect(page.getByText('-25')).toBeVisible();
  await expect(page.getByText('Owner changed to 0x1111…1111')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}hook-detail.png`, fullPage: true });
});

test('inbox: pinned brief, red alert, Yes / Change / No, nav badge; settings controls', async ({
  page,
}) => {
  await open(page, '/inbox');
  await expect(page.getByText('Portfolio: $2,600.00 (+1.2% in 24 h).')).toBeVisible();
  const red = page.getByRole('listitem', { name: /Hook 0xa0c0/ });
  await expect(red.getByText('Red alert')).toBeVisible();
  await expect(red.getByText('Simulated (demo)')).toBeVisible();
  await expect(red.getByText('Fresh human check')).toBeVisible();
  await expect(page.getByLabel('2 waiting for you').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}inbox.png`, fullPage: true });

  const dip = page.getByRole('listitem', { name: /ETH dipped/ });
  await dip.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Your agent is doing it now.')).toBeVisible();
  await expect(dip.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  await expect(page.getByLabel('1 waiting for you').first()).toBeVisible();

  await red.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Exit 100% of position pos1',
  );

  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await expect(page.getByLabel('Your time zone')).toHaveValue('Asia/Kolkata');
  await page.screenshot({ path: `${SHOTS}settings.png`, fullPage: true });
  await page.goto('/autopilot/mandate');
  await expect(page.getByRole('switch', { name: 'Auto-act: Dip buys' })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}autopilot-mandate.png`, fullPage: true });
});

test('a Telegram "Change" link opens the chat pre-filled and cleans the address', async ({
  page,
}) => {
  await open(page, '/?prefill=Buy%20%2420%20of%20ETH&suggestion=abc');
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Buy $20 of ETH',
  );
  await expect(page).not.toHaveURL(/prefill/);
});

test('the inbox fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/inbox');
  await expect(page.getByText('Morning brief').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}inbox-mobile.png`, fullPage: true });
});

test('old links keep their query string and the plan drawer still opens', async ({ page }) => {
  await open(page, '/inbox?plan=missing-plan');
  await expect(page).toHaveURL(/\/autopilot\?plan=missing-plan$/);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('LP actions and New rule reach the chat from their new views', async ({ page }) => {
  await open(page, '/portfolio');
  await expect(page.getByText('In range')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}portfolio.png`, fullPage: true });
  await page.getByRole('button', { name: 'Rebalance' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Rebalance my ETH/USDC position lp_1 around the current price',
  );
  await page.goto('/autopilot/mandate');
  await page.getByRole('button', { name: 'New rule' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Sell half if ETH goes up 2%',
  );
});

test('simulator: old path redirects, scenarios run, no action reads as deliberate', async ({
  page,
}) => {
  await open(page, '/inbox/simulator');
  await expect(page).toHaveURL(/\/autopilot\/simulator$/);
  await expect(page.getByRole('heading', { name: 'Market Event Simulator' })).toBeVisible();
  await expect(page.getByText('SIMULATED').first()).toBeVisible();
  await page.getByRole('button', { name: 'Paper' }).click();
  await expect(page.getByText(/nothing is broadcast/)).toBeVisible();
  await page.getByRole('button', { name: 'Trigger A better LP pool?' }).click();
  await expect(page.getByText('No action', { exact: true })).toBeVisible();
  await expect(page.getByText(/chose not to act/)).toBeVisible();
  await expect(page.getByText('Supports waiting')).toBeVisible();
  await expect(page.getByText('Move now')).toHaveCount(0);
  await page.getByRole('button', { name: 'Alternatives considered' }).click();
  await expect(page.getByText('Move now')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}autopilot-simulator.png`, fullPage: true });
});

test('show agent internals opens the trace beside the chat and is remembered', async ({ page }) => {
  await open(page, '/app');
  const internals = page.getByRole('switch', { name: 'Show agent internals' });
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toHaveCount(0);
  await internals.click();
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toBeVisible();
  await page.getByRole('switch', { name: 'Show agent internals' }).click();
});

test('sidebar collapses to a rail and remembers it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});

for (const width of [360, 768, 1024, 1440]) {
  test(`no sideways scroll on any view at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    for (const path of [
      '/',
      '/app',
      '/autopilot',
      '/autopilot/mandate',
      '/autopilot/simulator',
      '/portfolio',
      '/activity',
      '/hooks',
      '/settings',
    ]) {
      await page.goto(path);
      await expect(page.locator('#main')).toBeVisible();
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      if (width === 360)
        await page.screenshot({
          path: `${SHOTS}mobile${path === '/' ? '-home' : path.replace(/\//g, '-')}.png`,
        });
    }
  });
}

test('hooks is one tap away on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Hooks' }).click();
  await expect(page).toHaveURL(/\/hooks$/);
});

test('old /ask links land on the agent', async ({ page }) => {
  await open(page, '/ask');
  await expect(page).toHaveURL(/\/app$/);
});

test('signed out: the connect screen, not a broken dashboard', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}sign-in.png` });
});

test('on a phone the plan drawer is a bottom sheet that closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, '/activity?plan=missing-plan');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  // It slides up, so measure where it comes to rest rather than a frame of the animation.
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return Math.round((box?.y ?? 0) + (box?.height ?? 0));
    })
    .toBe(800);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('reduced motion stops the breathing glow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/app');
  const name = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'agent-breathe';
    document.body.append(el);
    return getComputedStyle(el).animationName;
  });
  expect(name).toBe('none');
});

test('the keyboard reaches the tabs and shows a focus ring', async ({ page }) => {
  await open(page, '/autopilot');
  const tab = page.getByRole('navigation', { name: 'Autopilot' }).getByRole('link', {
    name: 'Mandate',
  });
  await tab.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  expect(await tab.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/autopilot\/mandate$/);
});

test('the approval link the API sends still works, and Reject trades nothing', async ({ page }) => {
  await open(page, '/app');
  await ask(page, 'Swap $60 ETH to USDC');
  await expect(
    page
      .getByLabel('Approval needed')
      .last()
      .getByRole('button', { name: /Approve \(dev\)/ }),
  ).toBeVisible({ timeout: 15_000 });
  await page.goto('/autopilot');
  await expect(page.getByRole('button', { name: /Approve \(dev\)/ }).first()).toBeVisible();
  const pending = await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem('warden.session') ?? '{}').token;
    const res = await fetch('http://127.0.0.1:3901/approvals/pending', {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()) as { approvals: { id: string }[] };
  });
  await page.goto(`/approvals/${pending.approvals[0]!.id}`);
  await expect(page.getByRole('heading', { name: 'This needs you' })).toBeVisible();
  await expect(page.getByText('Expires in')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}approval-page.png` });
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/Nothing was traded/)).toBeVisible({ timeout: 10_000 });
});

test('the mandate states the real limits, and locked controls stay locked', async ({ page }) => {
  await open(page, '/autopilot/mandate');
  const chips = page.getByRole('list', { name: 'Your mandate' });
  await expect(chips.getByText('$25.00 per action')).toBeVisible();
  await expect(chips.getByText('$100.00 per day')).toBeVisible();
  await expect(chips.getByText('0.5% max slippage')).toBeVisible();
  await expect(page.getByRole('table').getByText('Safe hooks only')).toBeVisible();
  await expect(page.getByRole('button', { name: /Change profile/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Change limits/ })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}autopilot-mandate.png` });
});

test('settings shows the agent wallet and keeps Withdraw locked', async ({ page }) => {
  await open(page, '/settings');
  await expect(page.getByText('Privy policy enforced')).toBeVisible();
  await expect(page.getByRole('button', { name: /Withdraw/ })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Open mandate' })).toHaveAttribute(
    'href',
    '/autopilot/mandate',
  );
  await page.screenshot({ path: `${SHOTS}settings.png` });
});

test('the account menu shows the wallet, balance and a way out', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /Account menu/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Agent wallet')).toBeVisible();
  await expect(menu.getByText('$231.40')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
});

test('an unknown path is the not-found page, inside the shell', async ({ page }) => {
  await open(page, '/nowhere');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('the API being down shows a clear error with a retry', async ({ page }) => {
  await page.route('**/auth/providers', (route) => route.abort());
  await open(page);
  await expect(page.getByRole('heading', { name: "Can't reach SAKA" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();
});

test('onboarding still walks a new human through funding', async ({ page }) => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
  };
  const wallet = {
    address: '0xBB02Cfa69c391fb6238DcbEd4Af2BFb1eA40E69E',
    chainId: 11155111,
    createdAt: new Date().toISOString(),
    policyId: null,
  };
  await page.route('**/onboarding', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers })
      : route.fulfill({
          headers,
          json: {
            step: 'FUND',
            wallet,
            profile: 'BALANCED',
            limits: null,
            funding: {
              chainId: 11155111,
              faucets: [{ label: 'Sepolia faucet', url: 'https://example.com', asset: 'ETH' }],
              suggestedEth: '0.05',
              firstDeposit: null,
            },
          },
        }),
  );
  await page.route('**/me', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.user.onboardingStep = 'FUND';
    return route.fulfill({ response, json });
  });
  await open(page);
  await expect(page.getByRole('heading', { name: 'Fund your agent' })).toBeVisible();
  await expect(page.getByText(/Waiting for your deposit/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Sepolia faucet/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}onboarding-fund.png` });
});
