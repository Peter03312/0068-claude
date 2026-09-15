import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function setMemberCount(page: Page, n: number) {
  await page.getByLabel('成员数（2–8）').fill(String(n));
}

test('首页加载并显示三栏工作台与空状态', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '友谊缎带 · 跨组奇偶证明展签工作台' })).toBeVisible();
  await expect(page.getByText('还没有约束')).toBeVisible();
  await expect(page.getByText('还没有卡片')).toBeVisible();
  await expect(page.locator('svg.graph-svg')).toBeVisible();
});

test('合法展开卡通过，并报告在全部模型上核对', async ({ page }) => {
  await setMemberCount(page, 3);
  await addExpandCard(page, 'deg(A)', 'xAB + xAC');
  await addExpandCard(page, 'deg(B)', 'xAB + xBC');
  await expect(page.getByText(/共在 8 个满足约束的图模型上核对/)).toBeVisible();
  await expect(page.getByText('张卡的规则依据与全部模型核对都通过')).toBeVisible();
  await expect(page.locator('.card-item.bad')).toHaveCount(0);
});

test('形状错误的卡片被定位并高亮（deg(A)=0 不是度数展开）', async ({ page }) => {
  await setMemberCount(page, 3);
  await addExpandCard(page, 'deg(A)', '0');
  const bad = page.locator('.card-item.bad');
  await expect(bad).toHaveCount(1);
  await expect(bad).toContainText(/展开度数|边指示量|度数/);
  // 状态总览指向第 1 张卡
  await expect(page.getByText(/第 1 张卡未通过/)).toBeVisible();
});

test('归组错误：把跨组边写进 within() 即使条数相同也拒绝', async ({ page }) => {
  await setMemberCount(page, 3); // A,B 同组，C 另一组
  await page.getByRole('button', { name: '＋等式卡' }).click();
  const card = page.locator('.card-item').last();
  await card.locator('input').nth(0).fill('within()');
  await card.locator('input').nth(1).fill('xAC');
  await card.locator('select').first().selectOption('regroup');
  await expect(page.locator('.card-item.bad')).toHaveCount(1);
  await expect(page.locator('.card-item.bad')).toContainText(/不应包含|同组|跨组/);
});

test('只能引用更早的卡（第 1 张没有引用区）', async ({ page }) => {
  await setMemberCount(page, 3);
  await addExpandCard(page, 'deg(A)', 'xAB + xAC');
  await expect(page.locator('.card-item').first().getByText('引用前卡')).toHaveCount(0);
});

test('约束冲突时单独报告无模型，不借真空通过', async ({ page }) => {
  await setMemberCount(page, 3);
  await addConstraint(page, 'A', 'B', '必有');
  await addConstraint(page, 'B', 'A', '必无');
  await addExpandCard(page, 'deg(A)', 'xAB + xAC');
  await expect(page.getByText('约束无模型（单独报告）')).toBeVisible();
  await expect(page.getByText(/xAB 同时被要求/)).toBeVisible();
  await expect(page.getByText('张卡的规则依据与全部模型核对都通过')).toHaveCount(0);
});

test('目标奇偶式语义反例：最小反例、取值、SVG 高亮与边表联动', async ({ page }) => {
  await setMemberCount(page, 3); // 边序 xAB,xAC,xBC；deg(A)=xAB+xAC
  const target = page.locator('.target-box');
  await target.locator('input').nth(0).fill('deg(A)');
  await target.locator('input').nth(1).fill('0');
  await expect(page.getByText('目标奇偶式未达成')).toBeVisible();
  await expect(page.getByText(/最小反例下：左 = 1，右 = 0/)).toBeVisible();
  // 字典序最小使 deg(A) 奇的赋值是 xAB=0,xAC=1,xBC=0，仅 xAC 一条边高亮
  await expect(page.locator('line.edge-counter')).toHaveCount(1);
  const row = page.locator('table.ce-table tr', { hasText: 'xAC' });
  await expect(row).toContainText('1');
  const rowAB = page.locator('table.ce-table tr', { hasText: 'xAB' });
  await expect(rowAB).toContainText('0');
});

test('必有 xAB 时，deg(A)≡0 的最小反例从 [1,0,0] 开始', async ({ page }) => {
  await setMemberCount(page, 3);
  await addConstraint(page, 'A', 'B', '必有');
  const target = page.locator('.target-box');
  await target.locator('input').nth(0).fill('deg(A)');
  await target.locator('input').nth(1).fill('0');
  const rowAB = page.locator('table.ce-table tr', { hasText: 'xAB' });
  await expect(rowAB).toContainText('1');
  const rowAC = page.locator('table.ce-table tr', { hasText: 'xAC' });
  await expect(rowAC).toContainText('0');
  await expect(page.getByText(/左 = 1，右 = 0/)).toBeVisible();
});

test('JSON 导出再导入保持项目内容', async ({ page }) => {
  await setMemberCount(page, 3);
  await addExpandCard(page, 'deg(A)', 'xAB + xAC');
  await page.getByRole('button', { name: '导出 / 交接 JSON' }).click();
  const textarea = page.locator('.modal textarea');
  const text = await textarea.inputValue();
  expect(text).toContain('deg(A)');
  expect(text).toContain('"memberCount": 3');

  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '导入 JSON' }).click();
  await page.locator('.modal textarea').fill(text);
  await page.getByRole('button', { name: '导入并替换当前项目' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.getByText('张卡的规则依据与全部模型核对都通过')).toBeVisible();
  await expect(page.getByLabel('成员数（2–8）')).toHaveValue('3');
});

test('刷新后草稿本地恢复', async ({ page }) => {
  await setMemberCount(page, 4);
  await page.reload();
  await expect(page.getByLabel('成员数（2–8）')).toHaveValue('4');
});

// ---------- helpers ----------

async function addExpandCard(page: Page, left: string, right: string) {
  await page.getByRole('button', { name: '＋等式卡' }).click();
  const card = page.locator('.card-item').last();
  await card.locator('input').nth(0).fill(left);
  await card.locator('input').nth(1).fill(right);
  // 默认规则即展开度数
}

async function addConstraint(page: Page, a: string, b: string, status: string) {
  await page.getByRole('button', { name: '加一条' }).click();
  const row = page.locator('.constraint-row').last();
  await row.locator('select').nth(0).selectOption({ label: a });
  await row.locator('select').nth(1).selectOption({ label: b });
  await row.locator('select').nth(2).selectOption(status);
}
