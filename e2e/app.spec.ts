import { expect, test, type Page } from '@playwright/test';

// One stateful journey through a freshly deployed system (fresh database).
test.describe.configure({ mode: 'serial' });

// Reports never show future dates: periods are capped at today (Asia/Manila).
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
const MONTHS_SO_FAR = today.getMonth() + 1;
const DAYS_SO_FAR_THIS_WEEK = ((today.getDay() + 6) % 7) + 1;

const ADMIN = { name: 'Bill Admin', email: 'admin@billstore.test', password: 'Mango#Tree7!x' };
const OWNER = { name: 'Bill Owner', email: 'owner@billstore.test', temp: 'Temp#Owner1', password: 'Owner#Strong2026' };
const STAFF = { name: 'Sam Staff', email: 'staff@billstore.test', temp: 'Temp#Staff1', password: 'Staff#Strong2026' };

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

async function nav(label: string) {
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  if (label === 'Daily Stock Movements' || label === 'Stock Movement History') {
    const link = sidebar.getByRole('link', { name: label });
    if (!(await link.isVisible())) await sidebar.getByRole('button', { name: 'Stock Movements' }).click();
    await link.click();
  } else {
    await sidebar.getByRole('link', { name: label, exact: true }).click();
  }
}

async function login(email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function logout() {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Logout' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function expectToast(text: string | RegExp) {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}

test('fresh deployment shows the one-time administrator setup with a live password meter', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Initial administrator setup' })).toBeVisible();

  const pw = page.getByRole('textbox', { name: 'Password', exact: true });
  const label = page.getByTestId('strength-label');
  await pw.fill('a');
  await expect(label).toHaveText('Poor');
  await pw.fill('abcdefgh1');
  await expect(label).toHaveText('Weak');
  await pw.fill('Abcdefgh1');
  await expect(label).toHaveText('Fair');
  await pw.fill('Mango#Tr7');
  await expect(label).toHaveText('Good');
  await pw.fill('Mango#Tree7xz');
  await expect(label).toHaveText('Strong');
  await pw.fill('Mango#Tree7x!Rivr');
  await expect(label).toHaveText('Super Strong');

  // weak password is rejected by validation
  await page.getByLabel('Full name').fill(ADMIN.name);
  await page.getByLabel('Email address').fill(ADMIN.email);
  await pw.fill('weakpass');
  await page.getByLabel('Confirm password').fill('weakpass');
  await page.getByRole('button', { name: 'Create administrator account' }).click();
  await expect(page.getByText(/Password must include/)).toBeVisible();

  await pw.fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create administrator account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('card-ending_stock')).toHaveText('0');
});

test('initial setup cannot be repeated by visiting its URL', async () => {
  await page.goto('/setup');
  await expect(page).not.toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('admin manages categories, suppliers and customers (newest first)', async () => {
  await nav('Products');
  await page.getByRole('tab', { name: 'Categories' }).click();
  for (const name of ['Beverages', 'Food Products']) {
    await page.getByRole('button', { name: 'Add category' }).click();
    await page.getByRole('dialog').getByLabel('Category name').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expectToast('Category added.');
  }
  // newest category is listed first
  await expect(page.getByTestId('categories-table').locator('tbody tr').first()).toContainText('Food Products');
  // duplicate category is rejected
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.getByRole('dialog').getByLabel('Category name').fill('beverages');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast(/already exists/);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await nav('Suppliers');
  await page.getByRole('button', { name: 'Add supplier' }).first().click();
  await page.getByRole('dialog').getByLabel('Company / supplier name').fill('Metro Distributors');
  await page.getByRole('dialog').getByLabel('Contact person').fill('Ana Cruz');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast('Supplier added.');

  await nav('Customers');
  for (const name of ['Juan Dela Cruz', 'Maria Santos']) {
    await page.getByRole('button', { name: 'Add customer' }).first().click();
    await page.getByRole('dialog').getByLabel('Full name').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expectToast('Customer added.');
  }
  const firstRow = page.getByTestId('customers-table').locator('tbody tr').first();
  await expect(firstRow).toContainText('Maria Santos');
});

test('admin adds products with opening stock; newest product is listed first', async () => {
  await nav('Products');
  const add = async (p: { name: string; sku: string; category: string; unit: string; min: string; price: string; opening: string }) => {
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Product name').fill(p.name);
    await d.getByLabel('SKU / Barcode').fill(p.sku);
    await d.getByLabel('Category').selectOption({ label: p.category });
    await d.getByLabel('Unit').fill(p.unit);
    await d.getByLabel('Minimum stock level').fill(p.min);
    await d.getByLabel('Selling price').fill(p.price);
    await d.getByRole('spinbutton', { name: 'Opening stock', exact: true }).fill(p.opening);
    await d.getByRole('button', { name: 'Add product' }).click();
    await expect(d).toBeHidden(); // the form closes only once the product is saved
    await expectToast(/Product added/);
  };
  await add({ name: 'Cola 1L', sku: 'BEV-001', category: 'Beverages', unit: 'bottle', min: '20', price: '55', opening: '300' });
  await add({ name: 'Rice 5kg', sku: 'FOOD-001', category: 'Food Products', unit: 'sack', min: '10', price: '260', opening: '50' });
  const rows = page.getByTestId('products-table').locator('tbody tr');
  await expect(rows.first()).toContainText('Rice 5kg');
  await expect(rows.nth(1)).toContainText('Cola 1L');
  await expect(rows.nth(1)).toContainText('300');
});

test('stock in, sale, damaged stock-out and adjustment are recorded through the ledger', async () => {
  await nav('Stock Management');
  // Stock In
  await page.getByRole('tab', { name: 'Stock In' }).click();
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Cola 1L/ }).click();
  await page.getByLabel('Quantity received').fill('100');
  await page.getByLabel('Supplier').selectOption({ label: 'Metro Distributors' });
  await page.getByLabel('Reference no.').fill('DR-1001');
  await page.getByRole('button', { name: 'Record stock in' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stock changed from 300 to 400' })).toBeVisible();

  // Sale (Cola × 20, Juan Dela Cruz)
  await page.getByRole('tab', { name: 'Record Sale' }).click();
  await page.getByRole('combobox', { name: /^Add product/ }).click();
  await page.getByRole('option', { name: /Cola 1L/ }).click();
  await page.getByLabel('Quantity of Cola 1L').fill('20');
  await page.getByLabel('Customer').selectOption({ label: 'Juan Dela Cruz' });
  await page.getByLabel('Reference / receipt no.').fill('OR-0001');
  await page.getByRole('button', { name: /Complete sale/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record sale' }).click();
  await expectToast(/Sale OR-0001 recorded/);

  // Damaged stock-out (Rice × 5) — reason required
  await page.getByRole('tab', { name: 'Stock Out' }).click();
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Rice 5kg/ }).click();
  await page.getByLabel('Quantity released').fill('5');
  await page.getByRole('button', { name: 'Record stock out' }).click();
  await expect(page.getByText('A reason is required')).toBeVisible();
  await page.getByLabel('Reason / description').fill('Torn sacks');
  await page.getByRole('button', { name: 'Record stock out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record stock out' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stock changed from 50 to 45' })).toBeVisible();

  // Oversell is rejected server-side, nothing recorded
  await page.getByLabel('Quantity released').fill('9999');
  await page.getByLabel('Reason / description').fill('test');
  await page.getByRole('button', { name: 'Record stock out' }).click();
  await expect(page.getByText(/Only 45 sack available/)).toBeVisible();

  // Adjustment: physical count says 50
  await page.getByRole('tab', { name: 'Adjustment' }).click();
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Rice 5kg/ }).click();
  await page.getByLabel('New counted quantity').fill('50');
  await expect(page.getByTestId('adjustment-preview')).toContainText('+5');
  await page.getByLabel('Adjustment reason').fill('Physical count');
  await page.getByRole('button', { name: 'Record adjustment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record adjustment' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stock changed from 45 to 50' })).toBeVisible();
});

test('daily stock movements show beginning, in, sold, other out, adjustments and ending', async () => {
  await nav('Daily Stock Movements');
  // Everything was recorded today on a fresh system: 0 + 450 − 20 − 5 + 5 = 430
  await expect(page.getByTestId('card-beginning_stock')).toHaveText('0');
  await expect(page.getByTestId('card-stock_in')).toHaveText('+450');
  await expect(page.getByTestId('card-stock_sold')).toHaveText('−20');
  await expect(page.getByTestId('card-other_out')).toHaveText('−5');
  await expect(page.getByTestId('card-adjustments')).toHaveText('+5');
  await expect(page.getByTestId('card-ending_stock')).toHaveText('430');
  await expect(page.getByTestId('movement-table').locator('tbody tr')).toHaveCount(6);

  // product filter: Cola only → 0 + 400 − 20 = 380
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Cola 1L/ }).click();
  await expect(page.getByTestId('card-ending_stock')).toHaveText('380');

  // movement type filter limits the entries list
  await page.getByLabel('Movement type').selectOption({ label: 'Sold' });
  await expect(page.getByTestId('movement-table').locator('tbody tr')).toHaveCount(1);
});

test('stock movement history: dependent category→product filter and all four periods', async () => {
  await nav('Stock Movement History');
  await expect(page.getByRole('heading', { name: 'Stock Movement History' })).toBeVisible();
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Beverages' });
  // wait until the product picker has switched to the selected category
  await expect(page.getByRole('combobox', { name: 'Product (in selected category)' })).toBeEnabled();
  await page.getByRole('combobox', { name: /^Product/ }).click();
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options.filter({ hasText: 'Cola 1L' })).toHaveCount(1);
  await expect(options.filter({ hasText: 'Rice 5kg' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('card-ending_stock')).toHaveText('380');

  for (const [tab, rows] of [['Yearly', MONTHS_SO_FAR], ['Weekly', DAYS_SO_FAR_THIS_WEEK], ['Daily', 1]] as const) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByTestId('period-table').locator('tbody tr')).toHaveCount(rows);
    await expect(page.getByTestId('card-ending_stock')).toHaveText('380');
  }
  await page.getByRole('tab', { name: 'Monthly', exact: true }).click();
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'All categories' });
  await page.getByRole('tab', { name: 'By category' }).click();
  await expect(page.getByTestId('history-breakdown').locator('tfoot')).toContainText('430');
});

test('admin can deactivate and reactivate a product', async () => {
  await nav('Products');
  const colaRow = page.getByTestId('products-table').locator('tbody tr').filter({ hasText: 'Cola 1L' });
  await colaRow.getByRole('button', { name: 'Deactivate Cola 1L' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await expectToast(/deactivated/);
  await expect(page.getByTestId('products-table').locator('tbody tr').filter({ hasText: 'Cola 1L' })).toHaveCount(0);

  // hidden from Record Sale
  await nav('Stock Management');
  await page.getByRole('tab', { name: 'Record Sale' }).click();
  await page.getByRole('combobox', { name: /^Add product/ }).click();
  await expect(page.getByRole('listbox').getByRole('option', { name: /Cola 1L/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // still listed (with its stock) under "Show inactive", then reactivated
  await nav('Products');
  await page.getByLabel('Show inactive').check();
  const inactive = page.getByTestId('products-table').locator('tbody tr').filter({ hasText: 'Cola 1L' });
  await expect(inactive).toContainText('Inactive');
  await expect(inactive).toContainText('380');
  await inactive.getByRole('button', { name: 'Reactivate' }).click();
  await expectToast(/reactivated/);
  await page.getByLabel('Show inactive').uncheck();
  await expect(page.getByTestId('products-table').locator('tbody tr').filter({ hasText: 'Cola 1L' })).toHaveCount(1);
});

test('reports export to Excel and PDF', async () => {
  await nav('Reports');
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Stock-Sold Report' });
  await expect(page.getByTestId('report-table').locator('tbody tr')).toHaveCount(1);
  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel' }).click()]);
  expect(xlsx.suggestedFilename()).toMatch(/^stock-sold-report-.*\.xlsx$/);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);

  // Combined export: pick a few reports -> one Excel workbook with a tab per report
  await page.getByRole('button', { name: 'Export multiple reports' }).click();
  const bundle = page.getByRole('dialog', { name: 'Export multiple reports' });
  await bundle.getByRole('button', { name: 'Clear' }).click();
  for (const r of ['Inventory Summary', 'Stock-Sold Report', 'Monthly Stock Movement']) {
    await bundle.getByTestId('bundle-report-list').getByText(r, { exact: true }).click();
  }
  await expect(bundle.getByText('3 of 17 reports selected')).toBeVisible();
  const [combined] = await Promise.all([page.waitForEvent('download'), bundle.getByRole('button', { name: 'One Excel file' }).click()]);
  expect(combined.suggestedFilename()).toMatch(/^combined-report-.*\.xlsx$/);
  const XLSX = await import('xlsx');
  const { readFileSync } = await import('node:fs');
  const wb = XLSX.read(readFileSync(await combined.path()));
  expect(wb.SheetNames).toEqual(['Contents', 'Inventory Summary', 'Stock-Sold', 'Monthly Stock Movement']);
  // everything at once -> one PDF
  await bundle.getByRole('button', { name: 'Select all' }).click();
  const [allPdf] = await Promise.all([page.waitForEvent('download'), bundle.getByRole('button', { name: 'One PDF' }).click()]);
  expect(allPdf.suggestedFilename()).toMatch(/^complete-business-report-.*\.pdf$/);
  await bundle.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Low Stock Report' });
  await expect(page.getByTestId('report-table')).toHaveCount(0); // nothing low yet
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Yearly Stock Movement Report' });
  await expect(page.getByTestId('report-table').locator('tbody tr')).toHaveCount(MONTHS_SO_FAR);
});

test('admin creates owner and staff accounts via the admin-users Edge Function', async () => {
  await nav('User Management');
  for (const u of [
    { ...OWNER, role: 'owner' },
    { ...STAFF, role: 'staff' },
  ]) {
    await page.getByRole('button', { name: 'Create account' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Full name').fill(u.name);
    await d.getByLabel('Email address').fill(u.email);
    await d.getByLabel('Role').selectOption(u.role);
    await d.getByLabel('Temporary password').fill(u.temp);
    await d.getByLabel('Confirm password').fill(u.temp);
    await d.getByRole('button', { name: 'Create account' }).click();
    await expectToast(/account created/);
  }
  await expect(page.getByTestId('users-table').locator('tbody tr')).toHaveCount(3);
  await logout();
});

test('owner must change the temporary password and then has read-only access', async () => {
  await login(OWNER.email, OWNER.temp);
  await expect(page).toHaveURL(/\/profile/);
  await expect(page.getByText(/must change the temporary password/)).toBeVisible();
  const form = page.getByTestId('change-password-form');
  await form.getByLabel('Current password').fill(OWNER.temp);
  await form.getByRole('textbox', { name: 'New password', exact: true }).fill(OWNER.password);
  await form.getByLabel('Confirm new password').fill(OWNER.password);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(sidebar.getByRole('link', { name: 'User Management' })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Reports' })).toBeVisible();
  await nav('Products');
  await expect(page.getByTestId('products-table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await nav('Stock Management');
  await expect(page.getByRole('tab', { name: 'Stock In' })).toHaveCount(0);
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
  await logout();
});

test('staff can record stock but cannot adjust, view history or manage users', async () => {
  await login(STAFF.email, STAFF.temp);
  const form = page.getByTestId('change-password-form');
  await form.getByLabel('Current password').fill(STAFF.temp);
  await form.getByRole('textbox', { name: 'New password', exact: true }).fill(STAFF.password);
  await form.getByLabel('Confirm new password').fill(STAFF.password);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await nav('Stock Management');
  await expect(page.getByRole('tab', { name: 'Adjustment' })).toHaveCount(0);
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Rice 5kg/ }).click();
  await page.getByLabel('Quantity received').fill('10');
  await page.getByRole('button', { name: 'Record stock in' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stock changed from 50 to 60' })).toBeVisible();

  await nav('Products');
  await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0); // not authorised to add
  await page.goto('/movements/history');
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
  await logout();
});

test('repeated failed sign-ins lock the account temporarily', async () => {
  for (let i = 0; i < 5; i++) {
    await login(STAFF.email, 'Wrong#Pass1');
    await expect(page.getByRole('alert').filter({ hasText: /Invalid email or password|temporarily locked/ })).toBeVisible();
  }
  await login(STAFF.email, STAFF.password); // correct password, but locked
  await expect(page.getByRole('alert').filter({ hasText: /temporarily locked/ })).toBeVisible();
});

test('responsive layout on a phone', async ({ browser }) => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto('/login');
  await phone.getByLabel('Email address').fill(ADMIN.email);
  await phone.getByRole('textbox', { name: 'Password', exact: true }).fill(ADMIN.password);
  await phone.getByRole('button', { name: 'Sign in' }).click();
  await expect(phone.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await phone.getByRole('button', { name: 'Open menu' }).click();
  await phone.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Products', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
  await expect(phone.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await phone.screenshot({ path: 'test-results/mobile-products.png', fullPage: false });
  await phone.close();
});

test('notification bell lists stock alerts and opens the right place to act', async () => {
  await login(ADMIN.email, ADMIN.password);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  // make Rice 5kg low on stock (minimum is 10)
  await nav('Stock Management');
  await page.getByRole('tab', { name: 'Adjustment' }).click();
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: /Rice 5kg/ }).click();
  await page.getByLabel('New counted quantity').fill('5');
  await page.getByLabel('Adjustment reason').fill('Count for notification test');
  await page.getByRole('button', { name: 'Record adjustment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record adjustment' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'to 5' })).toBeVisible();

  await page.reload();
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/[1-9]\d* unread/);
  await bell.click();
  const notice = page.getByTestId('notification-list').getByRole('button', { name: /Rice 5kg is running low/ });
  await expect(notice).toContainText('5 sack left');
  await notice.click();
  await expect(page).toHaveURL(/\/stock\?tab=stock_in&product=\d+/);
  await expect(page.getByRole('combobox', { name: /^Product/ })).toHaveValue(/Rice 5kg/);
});

test('admin deletes an account, can recover it within 7 days', async () => {
  await nav('User Management');
  const staffRow = () => page.getByTestId('users-table').locator('tbody tr').filter({ hasText: STAFF.email });
  await staffRow().getByRole('button', { name: `Delete ${STAFF.name}` }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently deleted after 7 days');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expectToast(/will be permanently deleted in 7 days/);
  await expect(staffRow()).toContainText('Deletion pending');
  await expect(staffRow()).toContainText('7 day(s) left to recover');

  // the bell reminds the admin
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByTestId('notification-list')).toContainText(`${STAFF.name}'s account will be deleted`);
  await page.keyboard.press('Escape');

  await staffRow().getByRole('button', { name: `Recover ${STAFF.name}` }).click();
  await expectToast(/was recovered/);
  await expect(staffRow()).toContainText('Active');
  await expect(staffRow().getByRole('button', { name: `Delete ${STAFF.name}` })).toBeVisible();
});

test('users can upload, change and remove their profile photo', async () => {
  await nav('Profile');
  await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();
  const photo = page.getByTestId('profile-photo');
  await page.getByLabel('Choose profile photo').setInputFiles('public/logo-192.png');
  await expectToast('Profile photo updated.');
  // shown on the profile page and in the top bar
  await expect(photo.getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();
  await expect(page.locator('header').getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();
  const src = await photo.getByRole('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(src!.length).toBeLessThan(200_000); // resized before upload

  await nav('User Management');
  await expect(page.getByTestId('users-table').getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();

  await nav('Profile');
  await photo.getByRole('button', { name: 'Remove' }).click();
  await expectToast('Profile photo removed.');
  await expect(photo.getByRole('img')).toHaveCount(0);
  await expect(photo.getByRole('button', { name: 'Upload photo' })).toBeVisible();
});

test('forgot password: emailed link opened in another browser lets the user set a new password', async ({ browser, request }) => {
  await logout();
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/a password reset link has been sent/)).toBeVisible();

  // The link the email contains. Point it at the home page (as Supabase does when the
  // reset page isn't in its redirect list) to prove the app still opens the reset screen.
  const { link } = await (await request.get(`http://127.0.0.1:54400/__test/recovery-link?email=${OWNER.email}`)).json();
  expect(link).toContain('type=recovery');
  const homeLink = link.replace(/redirect_to=[^&]*/, `redirect_to=${encodeURIComponent('http://127.0.0.1:4180/')}`);

  // Open it in a completely separate browser (e.g. the phone's mail app).
  const phone = await browser.newContext();
  const p = await phone.newPage();
  await p.goto(homeLink);
  await expect(p.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  const NEW_PASSWORD = 'Owner#Reset2026!';
  await p.getByRole('textbox', { name: 'New password', exact: true }).fill(NEW_PASSWORD);
  await p.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await p.getByRole('button', { name: 'Update password' }).click();
  await expect(p).toHaveURL(/\/login$/);
  await expect(p.locator('[data-sonner-toast]').filter({ hasText: 'Password updated' })).toBeVisible();

  // The new password works; the old one no longer does.
  await p.getByLabel('Email address').fill(OWNER.email);
  await p.getByRole('textbox', { name: 'Password', exact: true }).fill(OWNER.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('alert').filter({ hasText: /Invalid email or password/ })).toBeVisible();
  await p.getByRole('textbox', { name: 'Password', exact: true }).fill(NEW_PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

  // A reset link works only once.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByRole('heading', { name: 'Reset link invalid or expired' })).toBeVisible();
  await phone.close();
});
