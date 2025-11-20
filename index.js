#!/usr/bin/env node

/**
 * CMX / KuferSQL / KuferConnect Automation Script
 *
 * - Lädt Session-Cookies aus cookies.json
 * - Liest Kurs- und Statuskonfiguration aus courses.yml
 * - Ruft pro Kurs die Veranstaltungsseite auf und liest den Status
 * - Extrahiert Teilnehmer inkl. Link zur Anmeldung
 * - Lädt für jeden Teilnehmer die E-Mail-Adresse
 * - Erkennt Kurs-Statuswechsel (pro Kurs) über status.json
 * - Sendet bei Statuswechsel E-Mails über SMTP (nodemailer, Konfiguration aus smtp.json)
 *
 * Ausführung:
 *   node index.js
 *
 * Voraussetzungen:
 *   npm install puppeteer nodemailer js-yaml
 *
 * Das Script ist bewusst so gebaut, dass es einmalig läuft
 * und sich danach beendet (cronfreundlich).
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const yaml = require('js-yaml');
// dotenv für .env-Unterstützung
require('dotenv').config();

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const access = util.promisify(fs.access);

// Konstante Einstellungen
const STATUS_SELECTOR = 'a[id*="_mf_status"]';

const STATUS_FILE = path.join(process.cwd(), 'status.json');
const AUTH_FILE = path.join(process.cwd(), 'auth.json');
const COOKIES_FILE = path.join(process.cwd(), 'cookies.json'); // Legacy-Name
const SMTP_FILE = path.join(process.cwd(), 'smtp.json');
const COURSES_FILE = path.join(process.cwd(), 'courses.yml');
const EMAIL_TEMPLATES_FILE = path.join(
  process.cwd(),
  'email_templates.yml'
);

async function saveAuth(authData) {
  const existing = (await fileExists(AUTH_FILE))
    ? JSON.parse(await readFile(AUTH_FILE, 'utf8'))
    : {};
  const merged = {
    ...existing,
    adminNotificationEmail: authData.adminNotificationEmail || existing.adminNotificationEmail || null,
    login: authData.login || existing.login || null,
    cookies: authData.cookies || existing.cookies || []
  };
  await writeFile(AUTH_FILE, JSON.stringify(merged, null, 2), 'utf8');
  logInfo(`Auth-Daten (inkl. Cookies) in ${AUTH_FILE} gespeichert.`);
}
// Standard-Status, der den Versand auslöst (Fallback)
const CANCELLED_STATUS = 'ausgefallen';

// Retry-Konfiguration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

// Allgemeine Timeout-Konfiguration
const NAVIGATION_TIMEOUT_MS = 30000;
const SELECTOR_TIMEOUT_MS = 15000;

function logInfo(message, extra = null) {
  const time = new Date().toISOString();
  if (extra) {
    console.log(`[INFO] ${time} - ${message}`, extra);
  } else {
    console.log(`[INFO] ${time} - ${message}`);
  }
}

function logError(message, error = null) {
  const time = new Date().toISOString();
  if (error) {
    console.error(`[ERROR] ${time} - ${message}`, error);
  } else {
    console.error(`[ERROR] ${time} - ${message}`);
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadAuth() {
  const hasAuth = await fileExists(AUTH_FILE);
  const hasCookies = await fileExists(COOKIES_FILE);

  if (hasAuth) {
    logInfo(`Lade Auth- und Cookie-Daten aus ${AUTH_FILE}`);
    const raw = await readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : parsed;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('auth.json enthält keine Cookies (Feld "cookies").');
    }

    // .env zuerst prüfen, damit .env Login Vorrang hat
    const envUser = process.env.CMX_USERNAME || process.env.CMX_USER;
    const envPass = process.env.CMX_PASSWORD || process.env.CMX_PASS;
    const envLoginUrl = process.env.CMX_LOGIN_URL || null;
    const envPin = process.env.CMX_PIN || null;
    const envPhone = process.env.CMX_PHONE || null;

    const loginCredentials =
      parsed.login &&
      typeof parsed.login === 'object' &&
      typeof parsed.login.username === 'string' &&
      typeof parsed.login.password === 'string'
        ? {
            username: parsed.login.username,
            password: parsed.login.password,
            loginUrl: parsed.login.loginUrl || null,
            pin: parsed.login.pin || null,
            phone: parsed.login.phone || null
          }
        : null;

    // .env ersetzt/ergänzt login
    if (envUser && envPass) {
      logInfo('Verwende Login-Daten aus .env (CMX_USERNAME/CMX_PASSWORD).');
      parsed.login = {
        username: envUser,
        password: envPass,
        loginUrl: envLoginUrl,
        pin: envPin,
        phone: envPhone
      };
    }

    return {
      cookies,
      adminEmail:
        typeof parsed.adminNotificationEmail === 'string'
          ? parsed.adminNotificationEmail.trim()
          : null,
      login: parsed.login || null
    };
  }

  if (hasCookies) {
    logInfo(`Lade Cookies aus ${COOKIES_FILE}`);
    const raw = await readFile(COOKIES_FILE, 'utf8');
    const cookies = JSON.parse(raw);

    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('cookies.json enthält keine Cookies');
    }

    // .env Credentials auch hier verfügbar machen
    const envUser = process.env.CMX_USERNAME || process.env.CMX_USER;
    const envPass = process.env.CMX_PASSWORD || process.env.CMX_PASS;
    const envLoginUrl = process.env.CMX_LOGIN_URL || null;
    const envPin = process.env.CMX_PIN || null;
    const envPhone = process.env.CMX_PHONE || null;

    const login =
      envUser && envPass
        ? {
            username: envUser,
            password: envPass,
            loginUrl: envLoginUrl,
            pin: envPin,
            phone: envPhone
          }
        : null;

    return { cookies, adminEmail: null, login };
  }

  throw new Error(
    `Weder auth.json noch cookies.json gefunden. Erwartet unter: ${AUTH_FILE} bzw. ${COOKIES_FILE}`
  );
}

async function loadSmtpConfig() {
  logInfo(`Lade SMTP-Konfiguration aus ${SMTP_FILE}`);
  if (!(await fileExists(SMTP_FILE))) {
    throw new Error(
      `smtp.json nicht gefunden. Erwartet unter: ${SMTP_FILE}`
    );
  }
  const raw = await readFile(SMTP_FILE, 'utf8');
  const config = JSON.parse(raw);

  const requiredFields = ['host', 'port', 'secure', 'user', 'pass'];
  for (const key of requiredFields) {
    if (!(key in config)) {
      throw new Error(`smtp.json fehlt Feld "${key}"`);
    }
  }

  return config;
}

async function loadCoursesConfig() {
  logInfo(`Lade Kurskonfiguration aus ${COURSES_FILE}`);

  if (!(await fileExists(COURSES_FILE))) {
    throw new Error(
      `courses.yml nicht gefunden. Erwartet unter: ${COURSES_FILE}`
    );
  }

  const raw = await readFile(COURSES_FILE, 'utf8');
  let config;
  try {
    config = yaml.load(raw);
  } catch (err) {
    throw new Error(`Fehler beim Parsen von courses.yml: ${err.message}`);
  }

  if (!config || typeof config !== 'object') {
    throw new Error('courses.yml hat kein gültiges YAML-Objekt.');
  }

  const courses = Array.isArray(config.courses) ? config.courses : [];
  if (courses.length === 0) {
    throw new Error('courses.yml enthält keine Kurse unter "courses".');
  }

  for (const course of courses) {
    if (!course.url || typeof course.url !== 'string' || !course.url.trim()) {
      throw new Error(
        'Jeder Kurs in courses.yml benötigt ein Feld "url" mit einer vollständigen URL.'
      );
    }
  }

  const defaultTriggerStatus =
    typeof config.defaultTriggerStatus === 'string' &&
    config.defaultTriggerStatus.trim().length > 0
      ? config.defaultTriggerStatus.trim()
      : CANCELLED_STATUS;

  return { defaultTriggerStatus, courses };
}

async function loadStatusMap() {
  if (!(await fileExists(STATUS_FILE))) {
    logInfo('status.json nicht gefunden, starte mit leerer Statusmap.');
    return {};
  }

  try {
    const raw = await readFile(STATUS_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed.lastStatus === 'string') {
      // Legacy-Format: { "lastStatus": "in Durchführung" }
      logInfo(
        'status.json im Legacy-Format gefunden, migriere zu kursbezogener Struktur (gemeinsamer Eintrag "default").'
      );
      return { default: parsed.lastStatus };
    }

    if (
      parsed &&
      typeof parsed.lastStatus === 'object' &&
      parsed.lastStatus !== null
    ) {
      logInfo('status.json mit kursbezogener Statusmap geladen.');
      return parsed.lastStatus;
    }

    logInfo(
      'status.json ohne gültiges lastStatus-Feld, starte mit leerer Statusmap.'
    );
    return {};
  } catch (err) {
    logError(
      'Fehler beim Lesen von status.json, starte mit leerer Statusmap.',
      err
    );
    return {};
  }
}

async function saveStatusMap(statusMap) {
  const data = { lastStatus: statusMap };
  await writeFile(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
  logInfo('Aktualisierte Statusmap in status.json gespeichert.');
}

async function loadEmailTemplates() {
  logInfo(`Lade E-Mail-Templates aus ${EMAIL_TEMPLATES_FILE}`);

  if (!(await fileExists(EMAIL_TEMPLATES_FILE))) {
    logInfo('email_templates.yml nicht gefunden, verwende Default-Template.');
    return {
      default: {
        subject: 'Ihre Veranstaltung wurde abgesagt',
        text:
          'Hallo {{participantFirstName}} {{participantLastName}},\n\n' +
          'die von Ihnen gebuchte Veranstaltung "{{courseName}}" wurde leider abgesagt.\n' +
          'Wir informieren Sie über Ersatztermine oder Alternativen, sobald verfügbar.\n\n' +
          'Mit freundlichen Grüßen\n' +
          'Ihre VHS Lahnstein\n'
      },
      statusTemplates: {}
    };
  }

  const raw = await readFile(EMAIL_TEMPLATES_FILE, 'utf8');
  let config;
  try {
    config = yaml.load(raw);
  } catch (err) {
    throw new Error(`Fehler beim Parsen von email_templates.yml: ${err.message}`);
  }

  if (!config || typeof config !== 'object') {
    throw new Error('email_templates.yml hat kein gültiges YAML-Objekt.');
  }

  const defaultTemplate =
    config.default && typeof config.default === 'object'
      ? config.default
      : null;
  const statusTemplates =
    config.statusTemplates && typeof config.statusTemplates === 'object'
      ? config.statusTemplates
      : {};

  if (!defaultTemplate || !defaultTemplate.subject || !defaultTemplate.text) {
    throw new Error(
      'email_templates.yml benötigt mindestens einen Eintrag "default" mit Feldern subject und text.'
    );
  }

  return { default: defaultTemplate, statusTemplates };
}

function getCourseKey(course) {
  if (course.id && typeof course.id === 'string' && course.id.trim()) {
    return course.id.trim();
  }
  if (course.url && typeof course.url === 'string' && course.url.trim()) {
    return course.url.trim();
  }
  throw new Error('Kurs in courses.yml besitzt weder id noch url.');
}

function getLastStatusForCourse(statusMap, courseKey) {
  if (!statusMap || typeof statusMap !== 'object') {
    return 'unknown';
  }
  const status = statusMap[courseKey];
  if (typeof status === 'string' && status.length > 0) {
    return status;
  }
  return 'unknown';
}

function setLastStatusForCourse(statusMap, courseKey, status) {
  // eslint-disable-next-line no-param-reassign
  statusMap[courseKey] = status;
}

async function withRetry(fn, description, maxRetries = MAX_RETRIES) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      attempt += 1;
      logInfo(`${description} (Versuch ${attempt}/${maxRetries})`);
      const result = await fn();
      return result;
    } catch (err) {
      if (attempt >= maxRetries) {
        logError(`${description} endgültig fehlgeschlagen.`, err);
        throw err;
      }
      logError(`${description} fehlgeschlagen, wiederhole...`, err);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function setupBrowserWithCookies(cookies) {
  logInfo('Starte Puppeteer (headless).');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);

  const cookieObjects = cookies.map((c) => {
    const { name, value, domain, path: cookiePath, httpOnly, secure } = c;
    const result = { name, value };
    if (domain) result.domain = domain;
    if (cookiePath) result.path = cookiePath;
    if (typeof httpOnly === 'boolean') result.httpOnly = httpOnly;
    if (typeof secure === 'boolean') result.secure = secure;
    return result;
  });

  logInfo('Setze Cookies für vhs-lahnstein.de.');
  await page.setCookie(...cookieObjects);

  return { browser, page };
}

async function tryLoginOnPage(page, loginConfig) {
  if (!loginConfig || !loginConfig.username || !loginConfig.password) {
    return false;
  }

  logInfo('Versuche automatischen Login mit gespeicherten Zugangsdaten.');

  // Falls eine explizite Login-URL angegeben ist, zuerst dorthin wechseln
  if (loginConfig.loginUrl) {
    await page.goto(loginConfig.loginUrl, { waitUntil: 'networkidle2' });
  }

  try {
    await page.waitForSelector('input[type="password"]', {
      timeout: 8000
    });
  } catch {
    logInfo('Kein Login-Formular gefunden, breche Auto-Login ab.');
    return false;
  }

  const success = await page.evaluate(
    ({ username, password }) => {
      const userInput =
        document.querySelector('input[type="email"]') ||
        Array.from(document.querySelectorAll('input[type="text"]')).find((inp) =>
          ['user', 'mail', 'login', 'email', 'kennung'].some((key) =>
            (inp.name || '').toLowerCase().includes(key) ||
            (inp.id || '').toLowerCase().includes(key) ||
            (inp.placeholder || '').toLowerCase().includes(key)
          )
        ) ||
        document.querySelector('input:not([type])');

      const passInput = document.querySelector('input[type="password"]');
      if (!passInput || !userInput) return false;

      userInput.value = username;
      passInput.value = password;

      const form = passInput.form || userInput.form;
      if (form) {
        form.submit();
        return true;
      }

      const submitButton =
        document.querySelector('button[type="submit"]') ||
        Array.from(document.querySelectorAll('button,input[type="submit"]')).find(
          (btn) =>
            /login|anmelden|anmeldung|sign in/i.test(
              (btn.textContent || btn.value || '')
            )
        );
      if (submitButton) {
        submitButton.click();
        return true;
      }

      return false;
    },
    { username: loginConfig.username, password: loginConfig.password }
  );

  if (!success) {
    logInfo('Login-Formular konnte nicht bedient werden.');
    return false;
  }

  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
  } catch {
    logInfo('Navigation nach Login-Submit nicht erkennbar, fahre fort.');
  }

  // Prüfen, ob Login-Formular verschwunden ist
  const stillOnLogin = await page.evaluate(() => {
    return Boolean(
      document.querySelector('input[type="password"]') ||
        document.querySelector('form[action*="Login"], form[action*="login"]')
    );
  });

  return !stillOnLogin;
}

async function attemptLoginAndRefresh(page, loginConfig, adminEmail) {
  const loggedIn = await tryLoginOnPage(page, loginConfig);
  if (!loggedIn) {
    logInfo('Auto-Login fehlgeschlagen oder nicht möglich.');
    return false;
  }

  const newCookies = await page.cookies();
  await saveAuth({
    adminNotificationEmail: adminEmail,
    login: loginConfig,
    cookies: newCookies
  });
  logInfo('Login erfolgreich, Cookies erneuert und gespeichert.');
  return true;
}

async function isLoggedOut(page) {
  try {
    await page.waitForSelector('body', { timeout: SELECTOR_TIMEOUT_MS });
  } catch {
    return false;
  }
  return page.evaluate(() =>
    Boolean(
      document.querySelector('input[type="password"]') ||
        document.querySelector('form[action*="Login"], form[action*="login"]')
    )
  );
}

async function ensureSession(auth, smtpConfig, probeUrl) {
  const setupResult = await withRetry(
    () => setupBrowserWithCookies(auth.cookies),
    'Starten von Puppeteer und Setzen der Cookies'
  );

  const { browser, page } = setupResult;

  const targetUrl =
    probeUrl ||
    (auth.login && auth.login.loginUrl) ||
    'https://vhs-lahnstein.de/';

  logInfo(`Prüfe Session auf ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2' });

  const loggedOut = await isLoggedOut(page);

  if (!loggedOut) {
    logInfo('Session gültig (kein Login-Formular erkannt).');
    return { browser, page };
  }

  logInfo('Session ungültig, versuche Auto-Login.');
  const loginOk = await attemptLoginAndRefresh(
    page,
    auth.login,
    auth.adminEmail
  );

  if (loginOk) {
    logInfo('Auto-Login erfolgreich, Session erneuert.');
    return { browser, page };
  }

  await sendAdminNotification(smtpConfig, auth.adminEmail, {
    courseName: 'SESSION_CHECK',
    courseId: 'SESSION_CHECK',
    courseUrl: targetUrl,
    reason: 'Login fehlgeschlagen: Cookies ungültig, Auto-Login nicht möglich.',
    participantsWithEmail: []
  });

  await browser.close();
  throw new Error('Login fehlgeschlagen, Session ungültig.');
}

async function extractStatusAndAppointments(page, eventUrl) {
  logInfo('Rufe Veranstaltungsseite auf:', eventUrl);
  await page.goto(eventUrl, { waitUntil: 'networkidle2' });

  logInfo('Suche Status-Element.');
  // Seite laden und Body sicher abwarten; Status-Element kann variieren.
  await page.waitForSelector('body', { timeout: SELECTOR_TIMEOUT_MS });
  try {
    await page.waitForSelector(STATUS_SELECTOR, { timeout: 5000 });
  } catch {
    // Ignorieren, wir suchen fallback-basiert weiter.
    logInfo('Direktes Status-Element nicht gefunden, verwende Fallback-Suche.');
  }

  const { statusText, appointments, notLoggedIn } = await page.evaluate(() => {
    const hasLoginForm =
      document.querySelector('input[type="password"]') ||
      document.querySelector('form[action*="Login"], form[action*="login"]');

    const statusCandidates = [
      'a[id*="_mf_status"]',
      'span[id*="_mf_status"]',
      'div[id*="_mf_status"]',
      '[class*="status"]',
      '[id*="status"]'
    ];

    let statusRaw = '';
    for (const sel of statusCandidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        statusRaw = el.textContent;
        break;
      }
    }

    // Fallback über Tabellenspalten/Label-Wert-Kombinationen
    if (!statusRaw) {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 2) continue;
        const label = (cells[0].innerText || cells[0].textContent || '').trim();
        const value = (cells[1].innerText || cells[1].textContent || '').trim();
        if (/status/i.test(label) && value) {
          statusRaw = value;
          break;
        }
      }
    }

    const statusText = (statusRaw || '').trim() || 'unknown';

    // Versuch, relevante Termine zu finden (Kufer/CMX variieren je nach Layout)
    const datePattern = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/;
    const timePattern = /\b\d{1,2}:\d{2}\b/;

    const collected = new Set();
    const maybeAdd = (text) => {
      const cleaned = (text || '').replace(/\s+/g, ' ').trim();
      if (!cleaned) return;
      if (!datePattern.test(cleaned)) return;
      if (!timePattern.test(cleaned) && !/termin/i.test(cleaned)) return;
      collected.add(cleaned);
    };

    // Tabellenzeilen, Listeneinträge und generische Container prüfen
    document
      .querySelectorAll('table tr, li, div, p, span')
      .forEach((node) => maybeAdd(node.innerText || node.textContent || ''));

    return {
      statusText,
      appointments: Array.from(collected),
      notLoggedIn: Boolean(hasLoginForm)
    };
  });

  logInfo(`Aktueller Status der Veranstaltung: ${statusText}`);
  logInfo(`Gefundene Termine für Veranstaltung: ${appointments.length}`);
  if (notLoggedIn) {
    logInfo('Login-Formular entdeckt, Cookies vermutlich abgelaufen.');
  }
  return { statusText, appointments, notLoggedIn };
}

async function navigateToRegistrationsTab(page) {
  logInfo('Wechsle zum Tab "Anmeldungen".');

  // Häufig ist der Tab als Link oder Button mit Text "Anmeldungen" vorhanden.
  // Wir versuchen zuerst über Textinhalt zu klicken, sonst über eine bekannte Struktur.
  const tabsSelector = 'a, button';

  await page.waitForSelector(tabsSelector, { timeout: SELECTOR_TIMEOUT_MS });

  const clicked = await page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll('a, button, span, div')
    );
    const target = elements.find((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text === 'anmeldungen';
    });
    if (target) {
      (target instanceof HTMLElement ? target : target.parentElement)?.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    logInfo(
      'Direkter Klick auf "Anmeldungen"-Tab nicht möglich, gehe davon aus, dass er bereits aktiv ist.'
    );
  } else {
    // Kurz warten, damit Inhalte nachladen können.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function extractParticipants(page, eventUrl) {
  logInfo('Extrahiere Teilnehmerliste.');
  logInfo('Rufe Veranstaltungsseite für Teilnehmerliste auf:', eventUrl);
  await page.goto(eventUrl, { waitUntil: 'networkidle2' });

  await navigateToRegistrationsTab(page);

  // Warten, bis mindestens ein Anmeldelink geladen wurde (ansonsten evtl. leeres Ergebnis)
  await page.waitForSelector('a[href*="App Anmeldung"]', {
    timeout: SELECTOR_TIMEOUT_MS
  });

  const participants = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll('a[href*="App Anmeldung"]')
    );

    const result = [];

    for (const link of anchors) {
      // Namen meist in <span> Nachbarn, sonst Textinhalt aufsplitten
      const spans = Array.from(link.querySelectorAll('span'));
      let lastName = '';
      let firstName = '';

      if (spans.length >= 2) {
        lastName = (spans[0].textContent || '').replace(/[, ]+/g, ' ').trim();
        firstName = (spans[1].textContent || '')
          .replace(/[, ]+/g, ' ')
          .trim();
      } else {
        const text = (link.textContent || '').trim();
        const parts = text.split(/[, ]+/).filter(Boolean);
        if (parts.length >= 2) {
          // heuristik: letzter Teil Nachname, erster Teil Vorname
          firstName = parts[0];
          lastName = parts.slice(1).join(' ');
        }
      }

      const href = link.getAttribute('href') || '';
      if (!href) continue;

      if (firstName || lastName) {
        result.push({
          firstName,
          lastName,
          registrationUrl: href
        });
      }
    }

    return result;
  });

  logInfo(`Gefundene Teilnehmer: ${participants.length}`);

  return participants;
}

async function extractEmailForParticipant(browser, participant) {
  logInfo(
    `Lade Anmeldeseite für Teilnehmer ${participant.firstName} ${participant.lastName}`
  );

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);

  const registrationUrl = participant.registrationUrl.startsWith('http')
    ? participant.registrationUrl
    : new URL(
        participant.registrationUrl,
        'https://vhs-lahnstein.de/'
      ).toString();

  await page.goto(registrationUrl, { waitUntil: 'networkidle2' });

  // 1) Direkte mailto-Links auf der Anmeldeseite prüfen
  const { directEmail, contactUrl } = await page.evaluate(
    (firstName, lastName) => {
      const anchors = Array.from(document.querySelectorAll('a'));

      const mailLink = anchors.find((a) =>
        (a.getAttribute('href') || '').startsWith('mailto:')
      );
      let directEmailResult = null;
      if (mailLink) {
        const href = mailLink.getAttribute('href') || '';
        const match = href.match(/^mailto:(.+)$/i);
        if (match) {
          directEmailResult = match[1].trim();
        }
      }

      // Kontaktlink enthält meist "App Kontakt", alternativ ist der Personenname klickbar.
      const contactAnchor =
        anchors.find((a) =>
          (a.getAttribute('href') || '').includes('App Kontakt')
        ) ||
        anchors.find((a) => {
          const text = (a.textContent || '').toLowerCase();
          return (
            text.includes(firstName.toLowerCase()) &&
            text.includes(lastName.toLowerCase())
          );
        });

      return {
        directEmail: directEmailResult,
        contactUrl: contactAnchor ? contactAnchor.getAttribute('href') : null
      };
    },
    participant.firstName,
    participant.lastName
  );

  if (directEmail) {
    await page.close();
    logInfo(
      `Gefundene E-Mail für ${participant.firstName} ${participant.lastName}: ${directEmail}`
    );
    return directEmail;
  }

  // 2) Wenn kein direkter Mail-Link vorhanden ist, den Kontakt-Link öffnen
  if (contactUrl) {
    const absoluteContactUrl = contactUrl.startsWith('http')
      ? contactUrl
      : new URL(contactUrl, 'https://vhs-lahnstein.de/').toString();

    logInfo(
      `Öffne Kontaktseite für ${participant.firstName} ${participant.lastName}: ${absoluteContactUrl}`
    );

    const contactPage = await browser.newPage();
    await contactPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await contactPage.setDefaultTimeout(SELECTOR_TIMEOUT_MS);

    await contactPage.goto(absoluteContactUrl, { waitUntil: 'networkidle2' });

    const emailFromContact = await contactPage.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a')).find((a) =>
        (a.getAttribute('href') || '').startsWith('mailto:')
      );
      if (!link) return null;
      const href = link.getAttribute('href') || '';
      const match = href.match(/^mailto:(.+)$/i);
      if (!match) return null;
      return match[1].trim();
    });

    await contactPage.close();
    await page.close();

    if (emailFromContact) {
      logInfo(
        `Gefundene E-Mail auf Kontaktseite für ${participant.firstName} ${participant.lastName}: ${emailFromContact}`
      );
      return emailFromContact;
    }
  }

  await page.close();
  logInfo(
    `Keine E-Mail-Adresse für ${participant.firstName} ${participant.lastName} gefunden.`
  );
  return null;
}

async function collectParticipantEmails(browser, participants) {
  const enriched = [];
  for (const participant of participants) {
    try {
      const email = await withRetry(
        () => extractEmailForParticipant(browser, participant),
        `E-Mail-Ermittlung für ${participant.firstName} ${participant.lastName}`
      );
      if (email) {
        enriched.push({ ...participant, email });
      }
    } catch (err) {
      logError(
        `E-Mail-Ermittlung für ${participant.firstName} ${participant.lastName} endgültig fehlgeschlagen.`,
        err
      );
    }
  }
  return enriched;
}

function renderTemplate(template, context) {
  return template.replace(/{{\s*([^}\s]+)\s*}}/g, (_, key) => {
    const value = context[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

function buildTransportOptions(smtpConfig) {
  const isPort465 = Number(smtpConfig.port) === 465;
  const isPort587 = Number(smtpConfig.port) === 587;

  // Port 465 = SMTPS (secure), Port 587 = STARTTLS (secure=false, requireTLS=true)
  const secure =
    isPort465 || (smtpConfig.secure === true && !isPort587)
      ? true
      : false;
  const requireTLS =
    isPort587 || smtpConfig.requireTLS === true ? true : false;

  return {
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure,
    requireTLS,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass
    }
  };
}

async function sendCancellationEmails(
  smtpConfig,
  participantsWithEmail,
  selectedTemplate,
  courseContext
) {
  if (participantsWithEmail.length === 0) {
    logInfo(
      'Keine Teilnehmer mit E-Mail-Adresse gefunden, es werden keine E-Mails versendet.'
    );
    return;
  }

  const transportOptions = buildTransportOptions(smtpConfig);
  logInfo(
    `Erzeuge SMTP-Transport (host=${transportOptions.host}, port=${transportOptions.port}, secure=${transportOptions.secure}, requireTLS=${transportOptions.requireTLS}).`
  );
  const transporter = nodemailer.createTransport(transportOptions);

  for (const participant of participantsWithEmail) {
    const to = participant.email;
    const context = {
      participantFirstName: participant.firstName || '',
      participantLastName: participant.lastName || '',
      courseName: courseContext.name || '',
      courseId: courseContext.id || '',
      courseUrl: courseContext.url || '',
      courseStatus: courseContext.status || ''
    };

    const subject = renderTemplate(selectedTemplate.subject, context);
    const text = renderTemplate(selectedTemplate.text, context);

    logInfo(`Sende E-Mail an ${to}`);

    try {
      await withRetry(
        () =>
          transporter.sendMail({
            from: smtpConfig.user,
            to,
            subject,
            text
          }),
        `E-Mail-Versand an ${to}`
      );
      logInfo(`E-Mail erfolgreich an ${to} gesendet.`);
    } catch (err) {
      logError(`E-Mail-Versand an ${to} endgültig fehlgeschlagen.`, err);
    }
  }
}

async function sendAdminNotification(smtpConfig, adminEmail, payload) {
  if (!adminEmail) {
    logInfo('Admin-Benachrichtigung nicht möglich (keine adminNotificationEmail gesetzt).');
    return;
  }

  const transportOptions = buildTransportOptions(smtpConfig);
  logInfo(
    `Erzeuge SMTP-Transport für Admin-Benachrichtigung (host=${transportOptions.host}, port=${transportOptions.port}, secure=${transportOptions.secure}, requireTLS=${transportOptions.requireTLS}).`
  );
  const transporter = nodemailer.createTransport(transportOptions);

  const participantList =
    payload.participantsWithEmail && payload.participantsWithEmail.length > 0
      ? payload.participantsWithEmail
          .map(
            (p) =>
              `- ${p.firstName} ${p.lastName} <${p.email}> (${p.registrationUrl || ''})`
          )
          .join('\n')
      : 'Keine Teilnehmer-E-Mails extrahiert.';

  const subject = `[CMX-Auto] Status unbekannt oder Login erforderlich für ${payload.courseName || payload.courseId}`;
  const text =
    `Hallo Admin,\n\n` +
    `Für den Kurs "${payload.courseName || payload.courseId}" konnte der Status nicht ermittelt werden (${payload.reason}).\n` +
    `Kurs-URL: ${payload.courseUrl}\n\n` +
    `Bitte prüfe die Cookies/den Login (auth.json) oder setze neue Cookies.\n\n` +
    `Teilnehmer (ermittelte E-Mails):\n${participantList}\n\n` +
    `Beste Grüße\nCMX-Auto\n`;

  try {
    await transporter.sendMail({
      from: smtpConfig.user,
      to: adminEmail,
      subject,
      text
    });
    logInfo(`Admin-Benachrichtigung an ${adminEmail} gesendet.`);
  } catch (err) {
    logError(`Admin-Benachrichtigung an ${adminEmail} fehlgeschlagen.`, err);
  }
}

async function main() {
  logInfo('Starte CMX-Automatisierungsscript.');

  let browser = null;

  try {
    const [
      auth,
      statusMap,
      smtpConfig,
      coursesConfig,
      emailTemplates
    ] = await Promise.all([
        loadAuth(),
        loadStatusMap(),
        loadSmtpConfig(),
        loadCoursesConfig(),
        loadEmailTemplates()
      ]);

    const cookies = auth.cookies;
    const adminEmail = auth.adminEmail;
    const login = auth.login;

    const probeUrl =
      (coursesConfig.courses && coursesConfig.courses[0] && coursesConfig.courses[0].url) ||
      (login && login.loginUrl) ||
      null;

    const session = await ensureSession(
      { cookies, adminEmail, login },
      smtpConfig,
      probeUrl
    );
    browser = session.browser;
    const page = session.page;

    for (const course of coursesConfig.courses) {
      const courseKey = getCourseKey(course);
      const triggerStatus =
        (course.triggerStatus &&
          typeof course.triggerStatus === 'string' &&
          course.triggerStatus.trim()) ||
        coursesConfig.defaultTriggerStatus ||
        CANCELLED_STATUS;

      logInfo(
        `Verarbeite Kurs ${courseKey} (${course.name || 'ohne Namen'}) mit Trigger-Status "${triggerStatus}".`
      );

      const lastStatusForCourse = getLastStatusForCourse(statusMap, courseKey);

      let {
        statusText: currentStatus,
        appointments,
        notLoggedIn
      } = await withRetry(
        () => extractStatusAndAppointments(page, course.url),
        `Status der Veranstaltung (${courseKey}) ermitteln`
      );

      let statusUnknown = currentStatus === 'unknown';

      // Falls nicht eingeloggt oder unbekannter Status: einmal autorisierter Login-Versuch und erneute Status-Ermittlung
      if ((statusUnknown || notLoggedIn) && login) {
        const loginOk = await attemptLoginAndRefresh(page, login, adminEmail);
        if (loginOk) {
          const retry = await withRetry(
            () => extractStatusAndAppointments(page, course.url),
            `Status der Veranstaltung nach Login (${courseKey}) ermitteln`
          );
          currentStatus = retry.statusText;
          appointments = retry.appointments;
          notLoggedIn = retry.notLoggedIn;
          statusUnknown = currentStatus === 'unknown';
        }
      }

      if (statusUnknown || notLoggedIn) {
        logInfo(
          `Status konnte nicht ermittelt werden (unknown). Grund: ${
            notLoggedIn
              ? 'Login/Session ungültig, bitte Cookies erneuern.'
              : 'Status-Element nicht gefunden.'
          }`
        );

        let participantsForAdmin = [];
        let participantsWithEmailForAdmin = [];
        try {
          participantsForAdmin = await withRetry(
            () => extractParticipants(page, course.url),
            `Teilnehmerliste extrahieren (Admin-Notfall ${courseKey})`,
            1
          );
          participantsWithEmailForAdmin = await collectParticipantEmails(
            browser,
            participantsForAdmin
          );
        } catch (err) {
          logError(
            `Konnte Teilnehmer für Admin-Benachrichtigung nicht extrahieren (${courseKey}).`,
            err
          );
        }

        await sendAdminNotification(smtpConfig, adminEmail, {
          courseName: course.name || courseKey,
          courseId: courseKey,
          courseUrl: course.url,
          reason: notLoggedIn
            ? 'Login/Session ungültig, bitte Cookies erneuern.'
            : 'Status-Element nicht gefunden.',
          participantsWithEmail: participantsWithEmailForAdmin
        });

        setLastStatusForCourse(statusMap, courseKey, currentStatus);
        continue;
      }

      const statusChangedToTrigger =
        currentStatus === triggerStatus &&
        lastStatusForCourse !== triggerStatus;

      if (!statusChangedToTrigger) {
        logInfo(
          `Kein relevanter Statuswechsel für Kurs ${courseKey}. Vorher: "${lastStatusForCourse}", jetzt: "${currentStatus}".`
        );
        setLastStatusForCourse(statusMap, courseKey, currentStatus);
        continue;
      }

      logInfo(
        `Statuswechsel für Kurs ${courseKey} erkannt: "${lastStatusForCourse}" -> "${currentStatus}". Starte Teilnehmerauswertung.`
      );

      const participants = await withRetry(
        () => extractParticipants(page, course.url),
        `Teilnehmerliste extrahieren (${courseKey})`
      );

      const participantsWithEmail = await collectParticipantEmails(
        browser,
        participants
      );

      const statusTemplate =
        (emailTemplates.statusTemplates || {})[triggerStatus] ||
        emailTemplates.default;

      await sendCancellationEmails(
        smtpConfig,
        participantsWithEmail,
        statusTemplate,
        {
          name: course.name || '',
          id: courseKey,
          url: course.url,
          status: currentStatus,
          appointments,
          appointmentsText: Array.isArray(appointments)
            ? appointments.map((a) => `- ${a}`).join('\n')
            : ''
        }
      );

      setLastStatusForCourse(statusMap, courseKey, currentStatus);
    }

    await saveStatusMap(statusMap);

    await browser.close();
    logInfo('Script erfolgreich abgeschlossen.');
  } catch (err) {
    logError('Unerwarteter Fehler im Script.', err);
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignorieren
      }
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
