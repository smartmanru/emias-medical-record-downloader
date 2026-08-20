import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const text = fsSync.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key) || !String(process.env[key] ?? '').trim()) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(SCRIPT_DIR, '.env'));

const OUTPUT_DIR = path.resolve(process.env.EMIAS_OUTPUT_DIR || path.join(SCRIPT_DIR, 'downloads'));
const TEMP_DIR = path.join(OUTPUT_DIR, '.tmp');
const DIAGNOSTICS_DIR = path.join(OUTPUT_DIR, '_diagnostics');
const STATE_FILE = path.join(OUTPUT_DIR, '.emias-state.json');
const REGISTRY_FILE = path.join(OUTPUT_DIR, 'реестр.csv');
const MAX_PAGES = positiveInt(process.env.EMIAS_MAX_PAGES, 250);
const SETTLE_MS = positiveInt(process.env.EMIAS_EVENT_SETTLE_MS, 350);
const SLOW_MO = positiveInt(process.env.EMIAS_SLOW_MO, 10);
const ACTION_DELAY_MS = positiveInt(process.env.EMIAS_ACTION_DELAY_MS, 600);
const RESTART_EVERY = positiveInt(process.env.EMIAS_RESTART_EVERY ?? process.env.EMIAS_RELOAD_EVERY, 20);
const DOCUMENT_LOAD_DELAY_MS = positiveInt(process.env.EMIAS_DOCUMENT_LOAD_DELAY_MS, 1_000);
const MODAL_APPEAR_TIMEOUT_MS = positiveInt(process.env.EMIAS_MODAL_APPEAR_TIMEOUT_MS, 4_000);
const DATE_TEXT_RE = /^\s*\d{2}\.\d{2}\.\d{4}\s*$/;
const DATE_FIND_RE = /\b(\d{2})\.(\d{2})\.(\d{4})\b/;
const ALL_TIME_RE = /^\s*((за|за всё|за все)\s+)?вс[её]\s+время\s*$|^\s*весь\s+период\s*$/i;
const ONLY_SECTION_KEYS = new Set(String(process.env.EMIAS_ONLY || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));

const CATEGORY_FOLDERS = {
  hospitalizations: 'Госпитализации',
  appointments: 'Приёмы',
  analyses: 'Анализы',
  research: 'Исследования',
  recipes: 'Рецепты',
  certificates: 'Справки и медицинские заключения',
  epicrisis: 'Выписки из стационара',
  consilium: 'Врачебные консилиумы',
};

const HOME_SECTIONS = [
  {
    key: 'appointments',
    label: 'приёмы',
    button: '#inspections_card_open_button',
    container: '#inspections_card_container',
    count: '[data-testid="inspections_card_count_value"]',
    allTime: '#inspections_card_all',
    modalDownloadRequired: true,
    actionVersion: 2,
  },
  {
    key: 'analyses',
    label: 'анализы',
    button: '#analyzes_card_open_button',
    container: '#analyzes_card_container',
    count: '[data-testid="analyzes_card_count_value"]',
    allTime: '#analyzes_card_all',
    directDownload: true,
    actionVersion: 2,
  },
  {
    key: 'research',
    label: 'исследования',
    button: '#research_card_open_button',
    container: '#research_card_container',
    count: '[data-testid="research_card_count_value"]',
    allTime: '#research_card_all',
    modalDownloadRequired: true,
    actionVersion: 2,
  },
  {
    key: 'recipes',
    label: 'рецепты',
    button: '#recipes_open_button',
    container: '#recipes_container',
    count: '[data-testid="recipes_count_value"]',
    allTime: '#recipes_list_all',
    nested: true,
    modalDownloadRequired: true,
    actionVersion: 2,
  },
  {
    key: 'certificates',
    label: 'справки и мед. заключения',
    button: '#medical-certificates_card_open_button',
    container: '#medical-certificates_card_container',
    count: '[data-testid="medical-certificates_card_count_value"]',
    allTime: '#medical-certificates_card_all',
    chapters: [
      '#medical_certificates_chapter',
      '#conclusions_chapter',
      '#recommendations_chapter',
      '#card026_chapter',
    ],
  },
  {
    key: 'epicrisis',
    label: 'выписки из стационара',
    button: '#epicrisis_card_open_button',
    container: '#epicrisis_card_container',
    count: '[data-testid="epicrisis_card_count_value"]',
    allTime: '#epicrisis_card_all',
    modalDownloadRequired: true,
    actionVersion: 2,
  },
  {
    key: 'consilium',
    label: 'врачебные консилиумы',
    button: '#consilium_card_open_button',
    container: '#consilium_card_container',
    count: '[data-testid="consilium_card_count_value"]',
    allTime: '#consilium_card_all',
    actionVersion: 3,
  },
];

let state;
let browser;
let context;
let page;
let homeUrl;
let sessionCredentials;
let sessionLaunchOptions;
let artifactsSinceRestart = 0;
let restartPending = false;

class BrowserRestartNeeded extends Error {
  constructor() {
    super('Требуется профилактический перезапуск браузера.');
    this.name = 'BrowserRestartNeeded';
  }
}

class IncompletePaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompletePaginationError';
  }
}

function isClosedTargetError(error) {
  return /target (?:page|context|browser).*closed|has been closed|browser.*disconnected/i.test(error?.message || '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${message}`);
}

function shouldProcessSection(key) {
  return ONLY_SECTION_KEYS.size === 0 || ONLY_SECTION_KEYS.has(key);
}

function noteArtifactHandled() {
  if (RESTART_EVERY === 0) return;
  artifactsSinceRestart += 1;
  if (artifactsSinceRestart >= RESTART_EVERY) restartPending = true;
}

async function closeBrowserSession() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  context = null;
  browser = null;
  page = null;
}

async function startBrowserSession() {
  browser = await chromium.launch(sessionLaunchOptions);
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await login(sessionCredentials.url, sessionCredentials.code);
}

async function waitForHomeReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const hospitalButton = page.locator('#hospitalization_open_button');
  const appointmentsButton = page.locator('#inspections_card_open_button');
  while (Date.now() < deadline) {
    const ready = await hospitalButton.isVisible().catch(() => false)
      && await hospitalButton.isEnabled().catch(() => false)
      && await appointmentsButton.isVisible().catch(() => false)
      && await appointmentsButton.isEnabled().catch(() => false);
    if (ready) return;
    await page.waitForTimeout(150);
  }
  throw new Error('Главная страница ЕМИАС осталась в состоянии загрузки: кнопки разделов не активировались.');
}

async function performPreventiveRestart(reason = `достигнут лимит ${RESTART_EVERY} документов`) {
  restartPending = false;
  artifactsSinceRestart = 0;
  await saveState();
  log(`Полный перезапуск Chrome (${reason}); состояние сохранено...`);
  await closeBrowserSession();
  await new Promise((resolve) => setTimeout(resolve, Math.max(ACTION_DELAY_MS, 500)));
  await startBrowserSession();
  log('Новый браузер запущен; продолжаю с сохранённого состояния.');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function shortHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function isoDateFromText(text) {
  const match = normalizeText(text).match(DATE_FIND_RE);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : 'без даты';
}

function titleFromRow(text, fallback) {
  const ignored = /^(скачать pdf|просмотр|назад|вперед|всё время|все время|6 мес(?:яцев)?|1 год|выписан)$/i;
  const parts = normalizeText(text)
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !DATE_TEXT_RE.test(part))
    .filter((part) => !ignored.test(part))
    .filter((part) => !/^выписан\s*:|^действ(?:ует|овал)\b|^тип рецепта\s*:|^вид рецепта\s*:|^действующий$|^отпущен$|^получите до\b/i.test(part));
  return parts.slice(0, 4).join(' — ') || fallback;
}

function safeName(value, maxLength = 165) {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'документ').slice(0, maxLength).trim();
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function promptCredentials() {
  let url = process.env.EMIAS_URL?.trim();
  let code = process.env.EMIAS_CODE?.trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!url) url = (await rl.question('Ссылка временного доступа ЕМИАС: ')).trim();
    if (!code) code = (await rl.question('Пятизначный код доступа: ')).trim();
  } finally {
    rl.close();
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Некорректная ссылка временного доступа.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'lk.emias.mos.ru') {
    throw new Error('Ожидалась HTTPS-ссылка с домена lk.emias.mos.ru.');
  }
  if (!/^\d{5}$/.test(code)) throw new Error('Код доступа должен состоять из пяти цифр.');
  return { url, code };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return {
      version: 1,
      actions: parsed.actions || {},
      visits: parsed.visits || {},
      hashes: parsed.hashes || {},
      records: parsed.records || [],
      audit: parsed.audit || {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') log(`Состояние не прочитано, начинаю новый реестр: ${error.message}`);
    return { version: 1, actions: {}, visits: {}, hashes: {}, records: [], audit: {} };
  }
}

async function saveState() {
  const temporary = `${STATE_FILE}.new`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, STATE_FILE);
  const header = ['дата документа', 'раздел', 'название', 'файл', 'статус', 'sha256', 'источник'];
  const rows = state.records.map((record) => [
    record.date,
    record.category,
    record.title,
    record.file || '',
    record.status,
    record.hash || '',
    record.source || '',
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  await fs.writeFile(REGISTRY_FILE, `\uFEFF${csv}`, 'utf8');
}

async function diagnose(label, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp} — ${safeName(label, 70)}`;
  log(`Ошибка в «${label}»: ${error.message}`);
  try {
    await page.screenshot({ path: path.join(DIAGNOSTICS_DIR, `${base}.png`), fullPage: true });
  } catch {}
  try {
    await fs.writeFile(path.join(DIAGNOSTICS_DIR, `${base}.html`), await page.content(), 'utf8');
  } catch {}
}

async function acceptCookies() {
  const button = page.getByRole('button', { name: /^принять$/i }).last();
  if (await button.isVisible().catch(() => false)) {
    await button.click().catch(() => {});
  }
}

async function waitForLoginStage(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  const header = page.locator('#header_container');
  const otp = page.locator('#otp_input');
  const loginButton = page.getByRole('button', { name: /^войти$/i });
  while (Date.now() < deadline) {
    if (await header.isVisible().catch(() => false)) return 'authenticated';
    if (await otp.isVisible().catch(() => false)) return 'otp';
    if (await loginButton.isVisible().catch(() => false)) return 'landing';
    await page.waitForTimeout(125);
  }
  throw new Error(`Не удалось распознать экран входа ЕМИАС. Адрес страницы: ${new URL(page.url()).origin}${new URL(page.url()).pathname}`);
}

async function waitForOtpOrAuthentication(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const header = page.locator('#header_container');
  const otp = page.locator('#otp_input');
  while (Date.now() < deadline) {
    if (await header.isVisible().catch(() => false)) return 'authenticated';
    if (await otp.isVisible().catch(() => false)) return 'otp';
    await page.waitForTimeout(125);
  }
  throw new Error('После нажатия «Войти» ЕМИАС не показал поле кода доступа.');
}

async function waitForAuthentication(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  const header = page.locator('#header_container');
  const submit = page.getByRole('button', { name: /продолжить|подтвердить/i }).last();
  const errorBox = page.locator('#login_snack_container, #snack');
  let submitClicked = false;
  while (Date.now() < deadline) {
    if (await header.isVisible().catch(() => false)) return;
    const errorText = normalizeText((await errorBox.allInnerTexts().catch(() => [])).join(' '));
    if (errorText) throw new Error(`ЕМИАС не принял вход: ${errorText}`);
    if (!submitClicked
      && await submit.isVisible().catch(() => false)
      && await submit.isEnabled().catch(() => false)) {
      await submit.click();
      submitClicked = true;
    }
    await page.waitForTimeout(125);
  }
  throw new Error('После ввода кода ЕМИАС не открыл медицинскую карту за 45 секунд.');
}

async function login(url, code) {
  log('Открываю гостевую ссылку ЕМИАС...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  let stage = await waitForLoginStage();
  if (stage === 'landing') {
    log('Нажимаю «Войти»...');
    await page.getByRole('button', { name: /^войти$/i }).click();
    stage = await waitForOtpOrAuthentication();
  }
  const otp = page.locator('#otp_input');
  if (stage === 'otp') {
    log('Ввожу код доступа...');
    await otp.click();
    await otp.fill('');
    await otp.pressSequentially(code, { delay: 70 });
    await page.waitForTimeout(250);
    await otp.press('Enter').catch(() => {});
  }

  await waitForAuthentication();
  await acceptCookies();
  log('Жду полной загрузки карточек медицинской карты...');
  await waitForHomeReady();
  homeUrl = page.url();
  log('Доступ подтверждён.');
}

async function gotoHome() {
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#header_container').waitFor({ state: 'visible', timeout: 30_000 });
  await acceptCookies();
  await waitForHomeReady();
}

async function readExpectedCounts() {
  const audit = {};
  for (const section of HOME_SECTIONS) {
    const text = await page.locator(section.count).textContent().catch(() => '');
    const uniqueFiles = new Set(state.records
      .filter((record) => record.auditKey === section.key && record.status === 'сохранён')
      .map((record) => record.hash)
      .filter(Boolean)).size;
    audit[section.key] = {
      expected: Number.parseInt(text || '0', 10) || 0,
      rowsSeen: state.audit[section.key]?.rowsSeen || 0,
      pagesSeen: state.audit[section.key]?.pagesSeen || 0,
      files: uniqueFiles,
      complete: state.audit[section.key]?.complete || false,
    };
  }
  const hospitalText = await page.locator('[data-testid="hospitalization_card_count_value"]').textContent().catch(() => '');
  audit.hospitalizations = {
    expected: Number.parseInt(hospitalText || '0', 10) || 0,
    rowsSeen: state.audit.hospitalizations?.rowsSeen || 0,
    pagesSeen: state.audit.hospitalizations?.pagesSeen || 0,
    files: new Set(state.records
      .filter((record) => record.auditKey === 'hospitalizations' && record.status === 'сохранён')
      .map((record) => record.hash)
      .filter(Boolean)).size,
    complete: state.audit.hospitalizations?.complete || false,
  };
  state.audit = { ...state.audit, ...audit };
  await saveState();
}

async function waitForCount(root, selector, expected, timeoutMs = 45_000) {
  if (!selector || expected <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await root.locator(selector).textContent().catch(() => '');
    const current = Number.parseInt(normalizeText(text).replace(/\D/g, ''), 10) || 0;
    if (current === expected) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function controlReceivesPointer(control) {
  if (!(await control.isVisible().catch(() => false))) return false;
  return await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') < 0.05) {
        return false;
      }
      current = current.parentElement;
    }
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }).catch(() => false);
}

async function waitForControlReady(control, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let previousBox = null;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const ready = await controlReceivesPointer(control);
    const box = ready ? await control.boundingBox().catch(() => null) : null;
    if (box && previousBox
      && Math.abs(box.x - previousBox.x) < 1
      && Math.abs(box.y - previousBox.y) < 1
      && Math.abs(box.width - previousBox.width) < 1
      && Math.abs(box.height - previousBox.height) < 1) {
      stableChecks += 1;
    } else {
      stableChecks = 0;
    }
    if (stableChecks >= 2) return true;
    previousBox = box;
    await page.waitForTimeout(150);
  }
  return false;
}

async function chooseAllTime(root, options = {}) {
  const {
    expectedCount = 0,
    countSelector = '',
    allTimeSelector = '',
    label = 'раздел',
    skipReactSelect = false,
  } = options;

  // Home cards have stable IDs. Wait for the card to finish opening instead of
  // guessing with a fixed delay: during its animation the button exists but is hidden.
  if (allTimeSelector) {
    const button = root.locator(allTimeSelector).first();
    const appeared = await button.waitFor({ state: 'visible', timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      throw new IncompletePaginationError(`${label}: карточка не раскрылась до кнопки «всё время».`);
    }
    const enableDeadline = Date.now() + 90_000;
    while (await button.isDisabled().catch(() => true)) {
      if (await waitForCount(root, countSelector, expectedCount, 500)) {
        log(`  ${label}: период «всё время» уже выбран (${expectedCount} записей).`);
        return true;
      }
      if (Date.now() >= enableDeadline) {
        throw new IncompletePaginationError(`${label}: кнопка «всё время» не разблокировалась.`);
      }
      await page.waitForTimeout(150);
    }
    await button.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await waitForControlReady(button, 90_000))) {
      throw new IncompletePaginationError(`${label}: кнопка «всё время» осталась перекрыта или не завершила анимацию.`);
    }
    await button.click({ timeout: 12_000 }).catch(() => button.click({ force: true }));
    if (!(await waitForCount(root, countSelector, expectedCount, 90_000))) {
      const actualText = await root.locator(countSelector).textContent().catch(() => 'неизвестно');
      throw new IncompletePaginationError(
        `${label}: после нажатия «всё время» показано ${normalizeText(actualText)} записей вместо ${expectedCount}.`,
      );
    }
    await page.waitForTimeout(500);
    log(`  ${label}: выбран период «всё время»${expectedCount > 0 ? ` (${expectedCount} записей)` : ''}.`);
    return true;
  }

  // The hospital list uses a React Select rather than the three card buttons.
  const selectInputs = root.locator('input[id^="react-select-"]');
  const selectAppeared = !skipReactSelect && await selectInputs.first().waitFor({ state: 'attached', timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  if (selectAppeared) {
    const input = selectInputs.first();
    const select = input.locator('xpath=ancestor::div[contains(@class,"container")][1]');
    const enableDeadline = Date.now() + 90_000;
    while (await input.isDisabled().catch(() => true)) {
      if (Date.now() >= enableDeadline) {
        throw new IncompletePaginationError(`${label}: список периодов не разблокировался.`);
      }
      await page.waitForTimeout(150);
    }
    await select.waitFor({ state: 'visible', timeout: 15_000 });
    const selectedText = normalizeText(await select.innerText().catch(() => ''));
    if (ALL_TIME_RE.test(selectedText)) {
      log(`  ${label}: выбран период «всё время».`);
      return true;
    }

    await select.click();
    await page.waitForTimeout(150);
    let option = page.locator('[role="option"]').filter({ hasText: ALL_TIME_RE }).last();
    if (!(await option.isVisible().catch(() => false))) {
      option = page.locator('[id*="-option-"]').filter({ hasText: ALL_TIME_RE }).last();
    }
    if (!(await option.isVisible().catch(() => false))) {
      const candidates = page.getByText(ALL_TIME_RE);
      for (let candidateIndex = (await candidates.count()) - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = candidates.nth(candidateIndex);
        if (await candidate.isVisible().catch(() => false)) {
          option = candidate;
          break;
        }
      }
    }
    if (!(await option.isVisible().catch(() => false))) {
      throw new IncompletePaginationError(`${label}: в списке периодов не найден пункт «всё время».`);
    }
    await option.click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = normalizeText(await select.innerText().catch(() => ''));
      if (ALL_TIME_RE.test(current)) {
        log(`  ${label}: выбран период «всё время».`);
        return true;
      }
      await page.waitForTimeout(125);
    }
    throw new IncompletePaginationError(`${label}: EMIAS не подтвердил выбор периода «всё время».`);
  }

  // Some cards use a real button; Recipes renders the period as a text tab.
  const allTimeTexts = root.getByText(ALL_TIME_RE);
  for (let index = 0; index < await allTimeTexts.count(); index += 1) {
    const text = allTimeTexts.nth(index);
    if (!(await text.isVisible().catch(() => false))) continue;
    const interactive = text.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]');
    const control = (await interactive.count()) > 0 && await interactive.first().isVisible().catch(() => false)
      ? interactive.first()
      : text;
    if (await control.isDisabled().catch(() => false)) {
      if (await waitForCount(root, countSelector, expectedCount, 2_000)) return true;
      continue;
    }
    await control.scrollIntoViewIfNeeded().catch(() => {});
    await control.click();
    if (!(await waitForCount(root, countSelector, expectedCount))) {
      const actualText = await root.locator(countSelector).textContent().catch(() => 'неизвестно');
      throw new IncompletePaginationError(
        `${label}: после нажатия «всё время» показано ${normalizeText(actualText)} записей вместо ${expectedCount}.`,
      );
    }
    await page.waitForTimeout(500);
    log(`  ${label}: выбран период «всё время»${expectedCount > 0 ? ` (${expectedCount} записей)` : ''}.`);
    return true;
  }

  throw new IncompletePaginationError(`${label}: не найдена кнопка или настройка периода «всё время».`);
}

async function annotateRows(root) {
  const rawRows = await root.evaluate((container) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let current = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') < 0.05) {
          return false;
        }
        if (current === container) break;
        current = current.parentElement;
      }
      return true;
    };
    container.querySelectorAll('[data-emias-auto-row]').forEach((element) => {
      element.removeAttribute('data-emias-auto-row');
    });
    // Recipes render dates inside labels such as "Выписан: 05.08.2026".
    const datePattern = /\b\d{2}\.\d{2}\.\d{4}\b/;
    const dateElements = [...container.querySelectorAll('*')].filter((element) => {
      return element.children.length === 0 && datePattern.test(element.textContent || '') && visible(element);
    });
    const unique = [];
    const seen = new Set();
    const addCandidate = (candidate, allowMissingDate = false) => {
      if (!candidate || candidate === container || seen.has(candidate) || !visible(candidate)) return false;
      const controls = [
        ...(candidate.matches('button, a') ? [candidate] : []),
        ...candidate.querySelectorAll('button, a'),
      ].filter(visible);
      const text = (candidate.innerText || '').trim();
      if (controls.length === 0 || controls.length > 8 || text.length === 0 || text.length > 900) return false;
      if (!allowMissingDate && !datePattern.test(text)) return false;
      seen.add(candidate);
      const id = String(unique.length + 1);
      candidate.setAttribute('data-emias-auto-row', id);
      unique.push({ id, text, buttons: controls.length });
      return true;
    };

    // Several EMIAS cards expose stable item containers. Prefer them so nested
    // chapters (for example Medical conclusions) do not depend on layout depth.
    for (const item of container.querySelectorAll('[data-itemid^="item_"]')) {
      addCandidate(item, true);
    }
    for (const dateElement of dateElements) {
      if ([...seen].some((candidate) => candidate.contains(dateElement))) continue;
      let candidate = dateElement.parentElement;
      while (candidate && candidate !== container) {
        const controls = [
          ...(candidate.matches('button, a') ? [candidate] : []),
          ...candidate.querySelectorAll('button, a'),
        ].filter(visible);
        const text = (candidate.innerText || '').trim();
        if (controls.length > 0 && controls.length <= 8 && text.length > 0 && text.length <= 900) break;
        candidate = candidate.parentElement;
      }
      addCandidate(candidate);
    }
    return unique;
  });

  const occurrences = new Map();
  return rawRows.map((row) => {
    row.text = normalizeText(row.text);
    const hash = shortHash(row.text);
    const occurrence = (occurrences.get(hash) || 0) + 1;
    occurrences.set(hash, occurrence);
    return { ...row, hash, occurrence, key: `${hash}-${occurrence}` };
  });
}

async function waitForRows(root, predicate = (rows) => rows.length > 0, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await annotateRows(root).catch(() => []);
    if (predicate(rows)) return rows;
    await page.waitForTimeout(150);
  }
  throw new IncompletePaginationError('Таблица документов не загрузилась за отведённое время.');
}

async function findRow(root, rowKey) {
  const rows = await annotateRows(root);
  const match = rows.find((row) => row.key === rowKey);
  return match ? root.locator(`[data-emias-auto-row="${match.id}"]`) : null;
}

async function visibleControls(locator) {
  const all = locator.locator('xpath=self::button | self::a | .//button | .//a');
  const result = [];
  for (let index = 0; index < await all.count(); index += 1) {
    const control = all.nth(index);
    if (await control.isVisible().catch(() => false)) result.push(index);
  }
  return result;
}

function rowControls(locator) {
  return locator.locator('xpath=self::button | self::a | .//button | .//a');
}

function categoryFolder(auditKey, category) {
  if (auditKey === 'hospitalizations') {
    const rawName = normalizeText(category)
      .replace(/^госпитализаци[яи]\s*[—-]\s*/i, '')
      .trim() || 'госпитализация';
    const readableName = safeName(rawName, 68);
    return path.join(CATEGORY_FOLDERS.hospitalizations, `${readableName} — ${shortHash(rawName).slice(0, 6)}`);
  }
  return CATEGORY_FOLDERS[auditKey] || safeName(category || 'Прочие документы', 70);
}

async function organizeExistingFiles() {
  const moved = new Map();
  for (const record of state.records) {
    if (!record.file) continue;
    const oldRelative = record.file;
    if (moved.has(oldRelative)) {
      record.file = moved.get(oldRelative);
      continue;
    }
    const source = path.join(OUTPUT_DIR, oldRelative);
    const folder = categoryFolder(record.auditKey, record.category);
    const directory = path.join(OUTPUT_DIR, folder);
    const currentFolder = path.dirname(oldRelative);
    if (path.normalize(currentFolder).toLowerCase() === path.normalize(folder).toLowerCase()) continue;
    if (!fsSync.existsSync(source)) continue;
    await fs.mkdir(directory, { recursive: true });
    const parsed = path.parse(path.basename(oldRelative));
    const targetBase = record.auditKey === 'hospitalizations'
      ? `${safeName(`${record.date} — ${record.title}`, 105)}${parsed.ext || '.pdf'}`
      : path.basename(oldRelative);
    const targetParsed = path.parse(targetBase);
    let destination = path.join(directory, targetBase);
    let suffix = 2;
    while (fsSync.existsSync(destination)) {
      destination = path.join(directory, `${targetParsed.name} — ${String(suffix).padStart(2, '0')}${targetParsed.ext}`);
      suffix += 1;
    }
    await fs.rename(source, destination);
    const newRelative = path.relative(OUTPUT_DIR, destination);
    moved.set(oldRelative, newRelative);
    record.file = newRelative;
  }
  for (const [hash, oldRelative] of Object.entries(state.hashes)) {
    if (moved.has(oldRelative)) state.hashes[hash] = moved.get(oldRelative);
  }
  if (moved.size > 0) {
    log(`Разложены по папкам ранее сохранённые файлы: ${moved.size}`);
    await saveState();
  }
}

async function uniqueDestination(meta, extension = '.pdf') {
  const ext = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : '.pdf';
  const directory = path.join(OUTPUT_DIR, categoryFolder(meta.auditKey, meta.category));
  await fs.mkdir(directory, { recursive: true });
  const hospitalDocument = meta.auditKey === 'hospitalizations';
  const stem = safeName(
    hospitalDocument ? `${meta.date} — ${meta.title}` : `${meta.date} — ${meta.category} — ${meta.title}`,
    hospitalDocument ? 105 : 145,
  );
  let candidate = path.join(directory, `${stem}${ext}`);
  let suffix = 2;
  while (fsSync.existsSync(candidate)) {
    candidate = path.join(directory, `${stem} — ${String(suffix).padStart(2, '0')}${ext}`);
    suffix += 1;
  }
  return candidate;
}

async function hashFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function finalizeTemporaryFile(tempPath, meta, source, extension) {
  const hash = await hashFile(tempPath);
  const desiredFolder = categoryFolder(meta.auditKey, meta.category);
  const duplicate = meta.auditKey === 'hospitalizations'
    ? state.records.find((record) => record.hash === hash
      && record.file
      && path.normalize(path.dirname(record.file)).toLowerCase() === path.normalize(desiredFolder).toLowerCase()
      && fsSync.existsSync(path.join(OUTPUT_DIR, record.file)))?.file
    : state.hashes[hash];
  if (duplicate) {
    await fs.unlink(tempPath).catch(() => {});
    state.records.push({ ...meta, file: duplicate, status: 'дубликат', hash, source });
    await saveState();
    noteArtifactHandled();
    return { duplicate: true, file: duplicate, hash };
  }
  const destination = await uniqueDestination(meta, extension);
  await fs.rename(tempPath, destination);
  const relative = path.relative(OUTPUT_DIR, destination);
  if (!state.hashes[hash]) state.hashes[hash] = relative;
  state.records.push({ ...meta, file: relative, status: 'сохранён', hash, source });
  if (state.audit[meta.auditKey]) state.audit[meta.auditKey].files += 1;
  await saveState();
  log(`  Сохранён: ${relative}`);
  noteArtifactHandled();
  return { duplicate: false, file: relative, hash };
}

async function saveDownload(download, meta, source) {
  const suggested = download.suggestedFilename() || 'document.pdf';
  const extension = path.extname(suggested) || '.pdf';
  const tempPath = path.join(TEMP_DIR, `${crypto.randomUUID()}${extension}`);
  await download.saveAs(tempPath);
  const failure = await download.failure();
  if (failure) throw new Error(`Скачивание завершилось ошибкой: ${failure}`);
  return await finalizeTemporaryFile(tempPath, meta, source, extension);
}

async function saveBuffer(buffer, meta, source, extension = '.pdf') {
  const tempPath = path.join(TEMP_DIR, `${crypto.randomUUID()}${extension}`);
  await fs.writeFile(tempPath, buffer);
  return await finalizeTemporaryFile(tempPath, meta, source, extension);
}

async function savePagePdf(targetPage, meta, source) {
  const tempPath = path.join(TEMP_DIR, `${crypto.randomUUID()}.pdf`);
  await targetPage.pdf({ path: tempPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  return await finalizeTemporaryFile(tempPath, meta, source, '.pdf');
}

async function isDownloadControlStuck(control) {
  return await control.evaluate((element) => {
    const ariaBusy = element.getAttribute('aria-busy') === 'true';
    const namedLoader = Boolean(element.querySelector(
      '[class*="spinner" i], [class*="loader" i], [data-testid*="loader" i], [data-testid*="spinner" i]',
    ));
    const animated = [element, ...element.querySelectorAll('*')].some((candidate) => {
      const style = window.getComputedStyle(candidate);
      return style.animationName !== 'none' && style.animationPlayState === 'running';
    });
    const disabled = element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    const visibleModal = document.querySelector('.ReactModal__Overlay--after-open, [role="dialog"]');
    const belongsToModal = Boolean(element.closest('.ReactModal__Overlay--after-open, [role="dialog"]'));
    return ariaBusy || namedLoader || animated || (disabled && (!visibleModal || belongsToModal));
  }).catch(() => false);
}

function capturedHasFile(captured) {
  if (captured.downloads.length > 0 || captured.popups.length > 0) return true;
  return captured.responses.some((response) => {
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const disposition = headers['content-disposition'] || '';
    return /pdf|octet-stream/i.test(contentType) || /attachment|\.pdf/i.test(disposition);
  });
}

async function reloadAfterStuckDownload() {
  log('  Кнопка скачивания зависла; сохраняю состояние и перезагружаю страницу...');
  await saveState();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  restartPending = true;
  throw new BrowserRestartNeeded();
}

async function captureClick(control, waitMs = SETTLE_MS) {
  const downloads = [];
  const popups = [];
  const responses = [];
  const onDownload = (download) => downloads.push(download);
  const onPage = (newPage) => {
    if (newPage !== page) popups.push(newPage);
  };
  const onResponse = (response) => responses.push(response);
  page.on('download', onDownload);
  page.on('response', onResponse);
  context.on('page', onPage);
  try {
    if (await isDownloadControlStuck(control)) await reloadAfterStuckDownload();
    try {
      await control.click({ timeout: 12_000 });
    } catch (error) {
      if (await isDownloadControlStuck(control)) await reloadAfterStuckDownload();
      throw error;
    }
    await page.waitForTimeout(waitMs);
    const captured = { downloads, popups, responses };
    if (!capturedHasFile(captured) && await isDownloadControlStuck(control)) {
      await reloadAfterStuckDownload();
    }
  } finally {
    page.off('download', onDownload);
    page.off('response', onResponse);
    context.off('page', onPage);
  }
  return { downloads, popups, responses };
}

async function saveCapturedArtifacts(captured, meta, source) {
  let saved = 0;
  for (const download of captured.downloads) {
    await saveDownload(download, meta, source);
    saved += 1;
  }
  for (const popup of captured.popups) saved += await savePopup(popup, meta);
  if (saved === 0) {
    for (const response of captured.responses || []) {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const disposition = headers['content-disposition'] || '';
      if (!/pdf|octet-stream/i.test(contentType) && !/attachment|\.pdf/i.test(disposition)) continue;
      const buffer = await response.body().catch(() => null);
      if (!buffer?.length) continue;
      const extension = /pdf/i.test(contentType) || /\.pdf/i.test(disposition) ? '.pdf' : '.bin';
      await saveBuffer(buffer, meta, `${source} (сетевой ответ)`, extension);
      saved += 1;
    }
  }
  return saved;
}

async function savePopup(popup, meta) {
  await popup.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {});
  const popupUrl = popup.url();
  try {
    if (/^https?:/i.test(popupUrl)) {
      const response = await context.request.get(popupUrl, { timeout: 30_000 });
      if (response.ok()) {
        const contentType = response.headers()['content-type'] || '';
        const urlExtension = path.extname(new URL(popupUrl).pathname).toLowerCase();
        const fileLike = /pdf|octet-stream|image\/(png|jpeg|tiff)/i.test(contentType)
          || /^\.(pdf|png|jpe?g|tiff?)$/i.test(urlExtension);
        if (fileLike) {
          const extension = contentType.includes('pdf') ? '.pdf' : urlExtension || '.pdf';
          await saveBuffer(await response.body(), meta, 'новая вкладка', extension);
          return 1;
        }
      }
    }
    if (/^(blob:|data:)/i.test(popupUrl)) {
      const base64 = await popup.evaluate(async () => {
        const response = await fetch(location.href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
        }
        return btoa(binary);
      });
      await saveBuffer(Buffer.from(base64, 'base64'), meta, 'blob из новой вкладки', '.pdf');
      return 1;
    }
    await savePagePdf(popup, meta, 'печать новой вкладки');
    return 1;
  } finally {
    await popup.close().catch(() => {});
  }
}

async function visibleModal() {
  const portals = page.locator('.ReactModalPortal:not(:empty), [role="dialog"]');
  for (let index = (await portals.count()) - 1; index >= 0; index -= 1) {
    const item = portals.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function waitForVisibleModal(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const modal = await visibleModal();
    if (modal) return modal;
    await page.waitForTimeout(75);
  }
  return null;
}

async function waitForModalContent(modal) {
  await page.waitForTimeout(DOCUMENT_LOAD_DELAY_MS);
  let previous = '';
  let stableChecks = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!(await modal.isVisible().catch(() => false))) return;
    const current = normalizeText(await modal.innerText().catch(() => ''));
    if (current.length > 20 && current === previous) stableChecks += 1;
    else stableChecks = 0;
    if (stableChecks >= 2) return;
    previous = current;
    await page.waitForTimeout(150);
  }
}

async function closeModal(modal) {
  if (!(await modal?.isVisible().catch(() => false))) return true;
  await page.keyboard.press('Escape').catch(() => {});
  if (await modal.waitFor({ state: 'hidden', timeout: 1_500 }).then(() => true).catch(() => false)) return true;

  const modalBox = await modal.boundingBox().catch(() => null);
  const buttons = modal.locator('button');
  if (modalBox) {
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      const box = await button.boundingBox().catch(() => null);
      const text = normalizeText(await button.innerText().catch(() => ''));
      if (!box) continue;
      const nearTopRight = box.x + box.width >= modalBox.x + modalBox.width - 140
        && box.y <= modalBox.y + 140;
      if (nearTopRight && text.length <= 3) {
        await button.click({ force: true }).catch(() => {});
        break;
      }
    }
  }
  return await modal.waitFor({ state: 'hidden', timeout: 4_000 }).then(() => true).catch(() => false);
}

async function ensureNoOpenModal() {
  const modal = await visibleModal();
  if (!modal) return;
  log('  Закрываю оставшееся окно документа перед следующим действием...');
  if (!(await closeModal(modal))) {
    restartPending = true;
    throw new BrowserRestartNeeded();
  }
  await page.waitForTimeout(200);
}

async function processModal(meta, waitForAppearance = false) {
  const modal = waitForAppearance
    ? await waitForVisibleModal(MODAL_APPEAR_TIMEOUT_MS)
    : await waitForVisibleModal(800);
  if (!modal) return 0;
  log('  Документ открыт; жду завершения загрузки окна...');
  await waitForModalContent(modal);
  let artifacts = 0;
  const downloadControls = modal.locator('button, a').filter({ hasText: /скачать/i });
  const controlCount = await downloadControls.count();
  for (let index = 0; index < controlCount; index += 1) {
    const control = downloadControls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await waitForControlReady(control, 15_000))) continue;
    const controlText = normalizeText(await control.innerText().catch(() => 'вложение'));
    const childMeta = { ...meta, title: safeName(`${meta.title} — ${controlText || 'вложение'}`) };
    const captured = await captureClick(control);
    artifacts += await saveCapturedArtifacts(captured, childMeta, 'вложение из просмотра');
    if (ACTION_DELAY_MS > 0) await page.waitForTimeout(ACTION_DELAY_MS);
  }
  if (artifacts === 0) {
    // The consilium modal exposes an icon-only download button at the bottom.
    // Scroll icon controls into the modal viewport and choose the last one,
    // excluding the close icon in the top-right corner.
    const controls = modal.locator('button, a, [role="button"]');
    for (let index = (await controls.count()) - 1; index >= 0; index -= 1) {
      const control = controls.nth(index);
      const text = normalizeText(await control.innerText().catch(() => ''));
      const hasIcon = (await control.locator('svg').count()) > 0;
      if (text || !hasIcon || !(await control.isVisible().catch(() => false))) continue;
      await control.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await waitForControlReady(control, 15_000))) continue;
      const modalBox = await modal.boundingBox().catch(() => null);
      const controlBox = await control.boundingBox().catch(() => null);
      if (!modalBox || !controlBox) continue;
      const nearTopRight = controlBox.x + controlBox.width >= modalBox.x + modalBox.width - 140
        && controlBox.y <= modalBox.y + 140;
      if (nearTopRight) continue;
      log('  Найдена кнопка загрузки внутри окна; скачиваю оригинал...');
      const captured = await captureClick(control, 5_000);
      artifacts += await saveCapturedArtifacts(captured, meta, 'кнопка загрузки из просмотра');
      if (artifacts > 0) break;
    }
  }
  if (artifacts === 0) {
    if (meta.requireOriginalDownload) {
      await closeModal(modal).catch(() => {});
      throw new Error('Кнопка загрузки в окне документа не вернула оригинальный файл.');
    }
    log('  Кнопка не вернула файл; сохраняю печатную копию окна.');
    await savePagePdf(page, { ...meta, title: `${meta.title} — просмотр` }, 'печать окна просмотра');
    artifacts += 1;
  }
  if (!(await closeModal(modal))) {
    restartPending = true;
    throw new BrowserRestartNeeded();
  }
  await page.waitForTimeout(250);
  return artifacts;
}

async function activateDocumentControl(control, meta, waitForModal, clickWaitMs = SETTLE_MS) {
  const startUrl = page.url();
  const captured = await captureClick(control, clickWaitMs);
  let artifacts = await saveCapturedArtifacts(
    captured,
    meta,
    waitForModal ? 'прямая кнопка' : 'прямая загрузка строки',
  );
  if (waitForModal) artifacts += await processModal(meta, true);

  if (page.url() !== startUrl && artifacts === 0) {
    const downloadLinks = page.locator('button, a').filter({ hasText: /скачать/i });
    for (let index = 0; index < await downloadLinks.count(); index += 1) {
      const link = downloadLinks.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;
      const capturedLink = await captureClick(link);
      for (const download of capturedLink.downloads) {
        await saveDownload(download, meta, 'страница просмотра');
        artifacts += 1;
      }
      for (const popup of capturedLink.popups) artifacts += await savePopup(popup, meta);
    }
    if (artifacts === 0) {
      await savePagePdf(page, { ...meta, title: `${meta.title} — просмотр` }, 'печать страницы просмотра');
      artifacts += 1;
    }
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }
  return artifacts;
}

function documentRows(rows, section) {
  const isHospitalDocument = section.key.startsWith('hospitalizations-');
  const allowsMissingDate = (section.auditKey || section.key) === 'certificates';
  return rows.filter((row) => {
    const dateCount = (row.text.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []).length;
    if (isHospitalDocument && dateCount !== 1) return false;
    if (/вернуться к списку обращений|дата поступления в стационар/i.test(row.text)) return false;
    return (allowsMissingDate || isoDateFromText(row.text) !== 'без даты') && row.buttons > 0;
  });
}

async function waitForDocumentPage(root, section, previousSignature = '', timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = documentRows(await annotateRows(root).catch(() => []), section);
    const signature = rows.map((row) => row.text).join('|');
    if (rows.length > 0 && (!previousSignature || signature !== previousSignature)) return rows;
    await page.waitForTimeout(150);
  }
  throw new IncompletePaginationError(`${section.label}: новая страница осталась в состоянии загрузки.`);
}

async function processCurrentDocumentPage(root, section, pageNumber) {
  const rows = documentRows(await annotateRows(root), section);
  let processedRows = 0;
  for (const row of rows) {
    const date = isoDateFromText(row.text);
    const title = titleFromRow(row.text, section.label);
    processedRows += 1;
    const meta = {
      date,
      category: section.label,
      title,
      auditKey: section.auditKey || section.key,
      requireOriginalDownload: Boolean(section.modalDownloadRequired),
    };
    const controls = await visibleControls(root.locator(`[data-emias-auto-row="${row.id}"]`));
    // EMIAS places the direct-download arrow first and the document preview last.
    // Analyses must use the original file behind the first arrow, never a printed preview.
    const actionIndexes = controls.length > 0
      ? [section.directDownload ? 0 : controls.length - 1]
      : [];
    for (const actionIndex of actionIndexes) {
      const actionVersion = section.actionVersion ? `|v${section.actionVersion}` : '';
      const actionKey = `${section.key}${actionVersion}|${pageNumber}|${row.key}|${actionIndex}`;
      const previousAction = state.actions[actionKey];
      if (previousAction?.status === 'done' && previousAction.artifacts > 0) continue;
      try {
        await ensureNoOpenModal();
        const freshRow = await findRow(root, row.key);
        if (!freshRow) throw new Error('Строка исчезла после обновления страницы.');
        const freshControls = await visibleControls(freshRow);
        const domIndex = freshControls[actionIndex];
        if (domIndex === undefined) throw new Error('Кнопка документа не найдена.');
        const documentControl = rowControls(freshRow).nth(domIndex);
        let artifacts = await activateDocumentControl(
          documentControl,
          meta,
          !section.directDownload,
          section.directDownload ? 2_000 : SETTLE_MS,
        );
        if (section.directDownload && artifacts === 0) {
          log('  Прямая кнопка не вернула файл с первого раза; повторяю...');
          await page.waitForTimeout(500);
          artifacts = await activateDocumentControl(documentControl, meta, false, 2_500);
        }
        if (section.directDownload && artifacts === 0 && freshControls.length > 1) {
          log('  Прямая загрузка недоступна; открываю просмотр и скачиваю оригинал из окна...');
          const fallbackRow = await findRow(root, row.key);
          if (!fallbackRow) throw new Error('Строка исчезла перед резервной загрузкой.');
          const fallbackControls = await visibleControls(fallbackRow);
          const previewDomIndex = fallbackControls.at(-1);
          if (previewDomIndex === undefined) throw new Error('Кнопка просмотра для резервной загрузки не найдена.');
          artifacts = await activateDocumentControl(
            rowControls(fallbackRow).nth(previewDomIndex),
            { ...meta, requireOriginalDownload: true },
            true,
          );
        }
        if (section.directDownload && artifacts === 0) {
          throw new Error('Прямая кнопка загрузки не вернула файл.');
        }
        state.actions[actionKey] = { status: 'done', artifacts, at: new Date().toISOString() };
        await saveState();
        if (ACTION_DELAY_MS > 0) await page.waitForTimeout(ACTION_DELAY_MS);
        if (restartPending) throw new BrowserRestartNeeded();
      } catch (error) {
        if (error instanceof BrowserRestartNeeded) throw error;
        state.actions[actionKey] = { status: 'error', error: error.message, at: new Date().toISOString() };
        await saveState();
        await diagnose(`${section.label} — ${title}`, error);
      }
    }
  }
  return { signature: rows.map((row) => row.text).join('|'), rowCount: processedRows };
}

async function paginator(root) {
  const found = await root.evaluate((container) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    container.querySelectorAll('[data-emias-paginator]').forEach((element) => {
      element.removeAttribute('data-emias-paginator');
    });
    const numericButtons = [...container.querySelectorAll('button')]
      .filter((button) => /^\s*\d+\s*$/.test(button.innerText || '') && visible(button));
    for (const numeric of numericButtons) {
      let candidate = numeric.parentElement;
      while (candidate && candidate !== container) {
        const buttons = [...candidate.querySelectorAll('button')].filter(visible);
        const numericCount = buttons.filter((button) => /^\s*\d+\s*$/.test(button.innerText || '')).length;
        const hasNavigation = buttons.some((button) => !/^\s*\d+\s*$/.test(button.innerText || ''));
        if (buttons.length >= 2 && numericCount >= 1 && hasNavigation) {
          candidate.setAttribute('data-emias-paginator', 'true');
          return true;
        }
        candidate = candidate.parentElement;
      }
    }
    return false;
  });
  return found ? root.locator('[data-emias-paginator="true"]').first() : null;
}

async function lastPageNumber(root) {
  const pager = await paginator(root);
  if (!pager) return 1;
  const buttons = pager.locator('button');
  let maximum = 1;
  for (let index = 0; index < await buttons.count(); index += 1) {
    const text = normalizeText(await buttons.nth(index).innerText().catch(() => ''));
    if (/^\d+$/.test(text)) maximum = Math.max(maximum, Number.parseInt(text, 10));
  }
  return maximum;
}

async function pageFingerprint(root) {
  const rows = await annotateRows(root);
  const pager = await paginator(root);
  let pagerState = '';
  if (pager) {
    pagerState = await pager.locator('button').evaluateAll((buttons) => buttons.map((button) => [
      (button.innerText || '').trim(),
      button.disabled ? 'disabled' : 'enabled',
      button.getAttribute('aria-current') || '',
      button.className || '',
    ].join(':')).join('|'));
  }
  return `${rows.map((row) => row.text).join('|')}::${pagerState}`;
}

async function clickNextPage(root, previousFingerprint) {
  const pager = await paginator(root);
  if (!pager) return false;
  let next = pager.locator('button').filter({ hasText: /^\s*вперед\s*$/i }).last();
  if (!(await next.isVisible().catch(() => false))) next = pager.locator('button').last();
  if (!(await next.isVisible().catch(() => false))) return false;
  if (await next.isDisabled().catch(() => false)) return false;
  const text = normalizeText(await next.innerText().catch(() => ''));
  if (/^\d+$/.test(text)) return false;
  await next.click();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(100);
    const fingerprint = await pageFingerprint(root);
    if (fingerprint && fingerprint !== previousFingerprint) return true;
  }
  return false;
}

async function processPaginatedDocuments(root, section) {
  let pageNumber = 1;
  let totalRows = 0;
  let knownLastPage = await lastPageNumber(root);
  const seen = new Set();
  while (pageNumber <= MAX_PAGES) {
    knownLastPage = Math.max(knownLastPage, await lastPageNumber(root));
    log(`  ${section.label}: страница ${pageNumber} из ${knownLastPage}`);
    const current = await processCurrentDocumentPage(root, section, pageNumber);
    const { signature } = current;
    totalRows += current.rowCount;
    const fingerprint = await pageFingerprint(root);
    if (!signature) break;
    if (seen.has(fingerprint)) {
      throw new IncompletePaginationError(`Повторно открылась страница ${pageNumber}; пагинация зациклилась.`);
    }
    seen.add(fingerprint);
    if (!(await clickNextPage(root, fingerprint))) break;
    pageNumber += 1;
    await waitForDocumentPage(root, section, signature);
  }
  if (pageNumber > MAX_PAGES) throw new Error(`Превышен лимит ${MAX_PAGES} страниц.`);
  const auditKey = section.auditKey || section.key;
  if (pageNumber < knownLastPage) {
    throw new IncompletePaginationError(`Пройдены не все страницы: ${pageNumber} из ${knownLastPage}.`);
  }
  if (section.trackRows !== false && state.audit[auditKey]) {
    const expected = state.audit[auditKey].expected || 0;
    state.audit[auditKey].rowsSeen = totalRows;
    state.audit[auditKey].pagesSeen = pageNumber;
    state.audit[auditKey].complete = pageNumber >= knownLastPage && (expected === 0 || totalRows >= expected);
    await saveState();
    if (expected > 0 && totalRows < expected) {
      throw new IncompletePaginationError(`Найдено ${totalRows} записей из ожидаемых ${expected}.`);
    }
  }
  await saveState();
  return { rows: totalRows, pages: pageNumber, lastPage: knownLastPage };
}

async function expandNestedRecipes(root) {
  const allTime = root.locator('#recipes_list_all');
  if (await waitForControlReady(allTime, 800)) {
    log('  рецепты: вложенный список уже раскрыт.');
    return;
  }
  const toggle = allTime.locator('xpath=ancestor::div[contains(@style,"max-height")][1]/preceding-sibling::button[1]');
  if (!(await toggle.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false))) {
    throw new IncompletePaginationError('рецепты: не найдена стрелка вложенной строки.');
  }
  await toggle.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await waitForControlReady(toggle, 60_000))) {
    throw new IncompletePaginationError('рецепты: стрелка вложенной строки осталась перекрыта.');
  }
  await toggle.click({ timeout: 12_000 }).catch(() => toggle.click({ force: true }));
  await page.waitForTimeout(500);
  await allTime.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await waitForControlReady(allTime, 60_000))) {
    throw new IncompletePaginationError('рецепты: вложенный список не завершил анимацию открытия.');
  }
  log('  рецепты: вложенный список раскрыт.');
}

async function processNestedChapters(root, section) {
  let totalRows = 0;
  let pagesSeen = 0;
  for (let chapterIndex = 0; chapterIndex < section.chapters.length; chapterIndex += 1) {
    const selector = section.chapters[chapterIndex];
    const toggle = root.locator(selector);
    await toggle.waitFor({ state: 'visible', timeout: 30_000 });
    const chapterLabel = normalizeText(await toggle.innerText().catch(() => `группа ${chapterIndex + 1}`));
    const panel = toggle.locator('xpath=following-sibling::div[1]');
    let rows = await annotateRows(panel).catch(() => []);
    const firstPanelControl = panel.locator('button, a').first();
    const panelReady = rows.length > 0 && await waitForControlReady(firstPanelControl, 500);
    if (!panelReady) {
      await toggle.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await waitForControlReady(toggle, 30_000))) {
        throw new IncompletePaginationError(`${section.label}: группа «${chapterLabel}» осталась перекрыта.`);
      }
      await toggle.click({ timeout: 12_000 }).catch(() => toggle.click({ force: true }));
      await page.waitForTimeout(700);
      const itemCount = await panel.locator('[data-itemid^="item_"], [id^="item_"]').count();
      if (itemCount > 0) {
        rows = await waitForRows(panel, (items) => items.length > 0, 30_000);
        await firstPanelControl.scrollIntoViewIfNeeded().catch(() => {});
        if (!(await waitForControlReady(firstPanelControl, 30_000))) {
          throw new IncompletePaginationError(`${section.label}: группа «${chapterLabel}» не завершила анимацию открытия.`);
        }
      }
    }
    log(`  ${section.label}: группа «${chapterLabel}», документов ${rows.length}.`);
    const summary = await processPaginatedDocuments(panel, {
      key: `${section.key}-chapter-${chapterIndex + 1}`,
      auditKey: section.key,
      trackRows: false,
      label: `${section.label} — ${chapterLabel}`,
    });
    totalRows += summary.rows;
    pagesSeen += summary.pages;
  }
  const expected = state.audit[section.key]?.expected || 0;
  state.audit[section.key].rowsSeen = totalRows;
  state.audit[section.key].pagesSeen = pagesSeen;
  state.audit[section.key].complete = expected === 0 || totalRows >= expected;
  await saveState();
  if (expected > 0 && totalRows < expected) {
    throw new IncompletePaginationError(`${section.label}: найдено ${totalRows} документов из ожидаемых ${expected}.`);
  }
}

async function processHomeSection(section) {
  let incompleteRetries = 0;
  while (true) {
    log(`Раздел «${section.label}»...`);
    try {
      await gotoHome();
      const openButton = page.locator(section.button);
      if (!(await openButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false))) {
        throw new IncompletePaginationError(`Не найдена кнопка ${section.button}`);
      }
      await openButton.click();
      const root = page.locator(section.container);
      if (section.nested) await expandNestedRecipes(root);
      await chooseAllTime(root, {
        expectedCount: state.audit[section.key]?.expected || 0,
        countSelector: section.count,
        allTimeSelector: section.allTime,
        label: section.label,
        skipReactSelect: section.nested === true,
      });
      if (section.chapters) {
        await processNestedChapters(root, section);
        return;
      }
      if ((state.audit[section.key]?.expected || 0) > 0) await waitForRows(root);
      await processPaginatedDocuments(root, section);
      return;
    } catch (error) {
      if (error instanceof BrowserRestartNeeded) {
        await performPreventiveRestart();
        continue;
      }
      if ((error instanceof IncompletePaginationError || isClosedTargetError(error)) && incompleteRetries < 2) {
        incompleteRetries += 1;
        log(`  Неполный проход «${section.label}»: ${error.message} Повторяю (${incompleteRetries}/2).`);
        await performPreventiveRestart(`повтор неполного раздела «${section.label}»`);
        continue;
      }
      throw error;
    }
  }
}

function hospitalRows(rows) {
  return rows.filter((row) => (row.text.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []).length >= 2 && row.buttons > 0);
}

function hospitalRowSignature(rows) {
  return rows.map((row) => row.text).join('|');
}

async function waitForHospitalPage(root, previousSignature = '', timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = hospitalRows(await annotateRows(root).catch(() => []));
    const signature = hospitalRowSignature(rows);
    if (rows.length > 0 && (!previousSignature || signature !== previousSignature)) return rows;
    await page.waitForTimeout(150);
  }
  throw new IncompletePaginationError('Список госпитализаций остался в состоянии загрузки.');
}

async function openHospitalListPage(targetPage = 1) {
  await gotoHome();
  const openButton = page.locator('#hospitalization_open_button');
  await openButton.waitFor({ state: 'visible', timeout: 30_000 });
  await openButton.click();
  const root = page.locator('body');
  await page.getByText(/Случаи обращения в стационарные медицинские организации/i)
    .waitFor({ state: 'visible', timeout: 60_000 });
  await chooseAllTime(root, { label: 'список госпитализаций' });
  let currentRows = await waitForHospitalPage(root);
  for (let pageNumber = 1; pageNumber < targetPage; pageNumber += 1) {
    const previousSignature = hospitalRowSignature(currentRows);
    const fingerprint = await pageFingerprint(root);
    if (!(await clickNextPage(root, fingerprint))) {
      throw new IncompletePaginationError(`Не удалось перейти к странице госпитализаций ${targetPage}.`);
    }
    currentRows = await waitForHospitalPage(root, previousSignature);
  }
  log(`  Список госпитализаций открыт на странице ${targetPage}.`);
  return root;
}

async function returnToHospitalList(expectedFingerprint, targetPage) {
  const back = page.getByText(/^\s*вернуться к списку обращений\s*$/i).first();
  await back.waitFor({ state: 'visible', timeout: 30_000 });
  await back.click();
  await page.getByText(/Случаи обращения в стационарные медицинские организации/i)
    .waitFor({ state: 'visible', timeout: 60_000 });
  const root = page.locator('body');
  await waitForRows(root, (rows) => hospitalRows(rows).length > 0);
  const returnedFingerprint = await pageFingerprint(root);
  if (returnedFingerprint === expectedFingerprint) {
    log('  Вернулся к списку обращений на прежнюю страницу.');
    return root;
  }
  log(`  После возврата позиция списка изменилась; восстанавливаю страницу ${targetPage}.`);
  return await openHospitalListPage(targetPage);
}

async function processHospitalizations() {
  const hospitalActionVersion = 2;
  const expectedVisits = state.audit.hospitalizations.expected || 0;
  const seenVisitKeys = new Set();
  let pageNumber = 1;
  let knownLastPage = 1;
  let root;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      root = await openHospitalListPage(1);
      knownLastPage = await lastPageNumber(root);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      log(`  Не удалось открыть список госпитализаций: ${error.message}. Повторяю (${attempt}/3).`);
      await performPreventiveRestart('повтор открытия списка госпитализаций');
    }
  }

  while (pageNumber <= MAX_PAGES) {
    knownLastPage = Math.max(knownLastPage, await lastPageNumber(root));
    let pageRows = hospitalRows(await annotateRows(root));
    if (!pageRows.length) {
      throw new IncompletePaginationError(`На странице госпитализаций ${pageNumber} не найдены строки.`);
    }
    const rowsOnPage = pageRows.length;
    log(`Госпитализации: страница ${pageNumber} из ${knownLastPage}, строк ${rowsOnPage}.`);

    for (let rowIndex = 0; rowIndex < rowsOnPage; rowIndex += 1) {
      pageRows = hospitalRows(await annotateRows(root));
      const descriptor = pageRows[rowIndex];
      if (!descriptor) {
        throw new IncompletePaginationError(`Госпитализация ${rowIndex + 1} исчезла со страницы ${pageNumber}.`);
      }
      const visitKey = `${pageNumber}-${rowIndex}-${shortHash(descriptor.text)}`;
      seenVisitKeys.add(visitKey);
      if (state.visits[visitKey]?.status === 'done'
        && state.visits[visitKey]?.complete
        && state.visits[visitKey]?.actionVersion === hospitalActionVersion) {
        log(`  Госпитализация ${rowIndex + 1}/${rowsOnPage}: уже обработана, пропускаю.`);
        continue;
      }

      const visitTitle = titleFromRow(descriptor.text, `случай ${rowIndex + 1}`);
      log(`  Госпитализация ${rowIndex + 1}/${rowsOnPage}: ${visitTitle}`);
      let visitFinished = false;
      let detailRetries = 0;
      while (!visitFinished) {
        try {
          pageRows = hospitalRows(await annotateRows(root));
          const current = pageRows[rowIndex];
          if (!current) throw new IncompletePaginationError('Случай госпитализации не найден на ожидаемой строке.');
          const currentKey = `${pageNumber}-${rowIndex}-${shortHash(current.text)}`;
          if (currentKey !== visitKey) {
            throw new IncompletePaginationError('Порядок госпитализаций изменился во время обработки.');
          }
          const listFingerprint = await pageFingerprint(root);
          const row = root.locator(`[data-emias-auto-row="${current.id}"]`);
          const controls = await visibleControls(row);
          if (!controls.length) throw new Error('Не найдена стрелка перехода в госпитализацию.');
          await rowControls(row).nth(controls.at(-1)).click();
          await page.getByText(/^\s*Документы\s*$/i).waitFor({ state: 'visible', timeout: 30_000 });
          const allTab = page.locator('#all_tab_button');
          if (await allTab.isVisible().catch(() => false)) await allTab.click().catch(() => {});
          await waitForRows(page.locator('body'), (rows) => rows.some((item) => {
            const dates = (item.text.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []).length;
            return dates === 1 && !/вернуться к списку обращений|дата поступления в стационар/i.test(item.text);
          }), 90_000).catch((error) => {
            throw new IncompletePaginationError(`Документы внутри госпитализации не загрузились: ${error.message}`);
          });
          const detailSection = {
            key: `hospitalizations-${visitKey}`,
            auditKey: 'hospitalizations',
            trackRows: false,
            label: safeName(`госпитализация — ${visitTitle}`, 90),
            directDownload: true,
            actionVersion: hospitalActionVersion,
          };
          const summary = await processPaginatedDocuments(page.locator('body'), detailSection);
          state.visits[visitKey] = {
            status: 'done',
            title: visitTitle,
            pageNumber,
            rowIndex,
            rowsSeen: summary.rows,
            pagesSeen: summary.pages,
            complete: summary.pages >= summary.lastPage,
            actionVersion: hospitalActionVersion,
            at: new Date().toISOString(),
          };
          await saveState();
          root = await returnToHospitalList(listFingerprint, pageNumber);
          visitFinished = true;
        } catch (error) {
          if (error instanceof BrowserRestartNeeded || isClosedTargetError(error)) {
            await performPreventiveRestart(isClosedTargetError(error) ? 'страница EMIAS была закрыта' : undefined);
            root = await openHospitalListPage(pageNumber);
            continue;
          }
          if (detailRetries < 2) {
            detailRetries += 1;
            log(`    Ошибка госпитализации: ${error.message}. Повторяю (${detailRetries}/2).`);
            await performPreventiveRestart('повтор госпитализации');
            root = await openHospitalListPage(pageNumber);
            continue;
          }
          state.visits[visitKey] = { status: 'error', error: error.message, pageNumber, rowIndex, at: new Date().toISOString() };
          await saveState();
          await diagnose(`госпитализация — ${visitTitle}`, error);
          root = await openHospitalListPage(pageNumber);
          visitFinished = true;
        }
      }
    }

    state.audit.hospitalizations.rowsSeen = seenVisitKeys.size;
    state.audit.hospitalizations.pagesSeen = pageNumber;
    state.audit.hospitalizations.complete = false;
    await saveState();

    const previousSignature = hospitalRowSignature(pageRows);
    const fingerprint = await pageFingerprint(root);
    const moved = await clickNextPage(root, fingerprint);
    if (!moved) {
      if (pageNumber < knownLastPage) {
        throw new IncompletePaginationError(`Список госпитализаций: пройдены ${pageNumber} из ${knownLastPage} страниц.`);
      }
      break;
    }
    pageNumber += 1;
    await waitForHospitalPage(root, previousSignature);
  }

  if (pageNumber > MAX_PAGES) throw new Error(`Превышен лимит ${MAX_PAGES} страниц госпитализаций.`);
  const visitKeys = [...seenVisitKeys];
  const completedVisits = visitKeys.filter((key) => state.visits[key]?.status === 'done'
    && state.visits[key]?.complete).length;
  state.audit.hospitalizations.rowsSeen = visitKeys.length;
  state.audit.hospitalizations.pagesSeen = pageNumber;
  state.audit.hospitalizations.complete = completedVisits === visitKeys.length
    && (expectedVisits === 0 || visitKeys.length >= expectedVisits);
  await saveState();
  if (!state.audit.hospitalizations.complete) {
    throw new IncompletePaginationError(
      `Госпитализации обработаны не полностью: ${completedVisits} из ${visitKeys.length} случаев (ожидалось ${expectedVisits || visitKeys.length}).`,
    );
  }
}

function printAudit() {
  console.log('\nАудит разделов:');
  for (const [key, value] of Object.entries(state.audit)) {
    const status = value.complete ? 'ПОЛНОСТЬЮ' : 'НЕПОЛНО';
    console.log(`- ${key}: ${status}; записей ${value.rowsSeen ?? 0}/${value.expected ?? '?'}, страниц ${value.pagesSeen ?? 0}, уникальных файлов ${value.files ?? 0}`);
  }
  console.log(`\nРеестр: ${REGISTRY_FILE}`);
  console.log(`Документы: ${OUTPUT_DIR}`);
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });
  state = await loadState();
  await organizeExistingFiles();
  if (process.env.EMIAS_ORGANIZE_ONLY === '1') {
    log('Существующие документы разложены по папкам; режим только организации завершён.');
    return;
  }
  sessionCredentials = await promptCredentials();
  const browserChoice = (process.env.EMIAS_BROWSER || 'chrome').toLowerCase();
  sessionLaunchOptions = {
    headless: process.env.EMIAS_HEADLESS === '1',
    downloadsPath: TEMP_DIR,
    slowMo: SLOW_MO,
  };
  if (browserChoice !== 'chromium') sessionLaunchOptions.channel = browserChoice;

  try {
    await startBrowserSession();
    await readExpectedCounts();
    const failures = [];
    if (shouldProcessSection('hospitalizations')) {
      try {
        await processHospitalizations();
      } catch (error) {
        failures.push(`госпитализации: ${error.message}`);
        await diagnose('госпитализации', error);
      }
    }
    for (const section of HOME_SECTIONS) {
      if (!shouldProcessSection(section.key)) continue;
      try {
        await processHomeSection(section);
      } catch (error) {
        failures.push(`${section.label}: ${error.message}`);
        await diagnose(section.label, error);
      }
    }
    await saveState();
    printAudit();
    const incomplete = Object.entries(state.audit)
      .filter(([key, value]) => shouldProcessSection(key) && value.expected > 0 && !value.complete)
      .map(([key]) => key);
    if (failures.length || incomplete.length) {
      throw new Error(`Выгрузка неполная. Ошибки: ${failures.join('; ') || 'нет'}. Неполные разделы: ${incomplete.join(', ') || 'нет'}.`);
    }
    log('Выгрузка завершена. Проверьте аудит и реестр.csv.');
  } catch (error) {
    await diagnose('критическая ошибка', error);
    throw error;
  } finally {
    await closeBrowserSession();
  }
}

main().catch(async (error) => {
  console.error(`\nКритическая ошибка: ${error.stack || error.message}`);
  await closeBrowserSession();
  process.exitCode = 1;
});
