#!/usr/bin/env node

/**
 * CMX / KuferSQL / KuferConnect Automation Script
 *
 * - Lädt Session-Cookies aus auth.json
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
const http = require('http');
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
const USER_DATA_DIR = path.join(__dirname, '.puppeteer-profile');
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

const STATUS_FILE = path.join(process.cwd(), 'status.json');
const AUTH_FILE = path.join(process.cwd(), 'auth.json');
const SMTP_FILE = path.join(process.cwd(), 'smtp.json');
const COURSES_FILE = path.join(process.cwd(), 'courses.yml');
const HISTORY_FILE = path.join(process.cwd(), 'status_history.json');
const EMAIL_TEMPLATES_FILE = path.join(
  process.cwd(),
  'email_templates.yml'
);
const INSTRUCTOR_PROFILE_URL =
  (process.env.CMX_INSTRUCTOR_PROFILE_URL || '').trim();

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

// SMS Webhook / PIN-Queue
const pinQueue = [];
let smsServerStarted = false;

function getWebhookConfig() {
  const token = process.env.SMS_WEBHOOK_TOKEN || null;
  if (!token) return null;
  return {
    token,
    port: Number(process.env.SMS_WEBHOOK_PORT) || 3000,
    path: process.env.SMS_WEBHOOK_PATH || '/sms-hook',
    timeoutMs: Number(process.env.SMS_WEBHOOK_TIMEOUT_MS) || 90000
  };
}

function startSmsWebhookServer() {
  const config = getWebhookConfig();
  if (!config || smsServerStarted) return;

  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      if (parsedUrl.pathname !== config.path) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }

      const tokenFromQuery = parsedUrl.searchParams.get('token');
      const authHeader = req.headers.authorization || '';
      const bearer =
        authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7)
          : null;

      if (tokenFromQuery !== config.token && bearer !== config.token) {
        res.statusCode = 403;
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          logError('Webhook-Body zu groß, Verbindung beendet.');
          req.destroy();
        }
      });
      req.on('end', () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (err) {
          logError('Konnte Webhook-Payload nicht parsen.', err);
        }

        const text =
          payload && typeof payload.text === 'string' ? payload.text : '';
        const match = text.match(/\b(\d{4,8})\b/);
        if (match) {
          const pin = match[1];
          pinQueue.push(pin);
          logInfo(`SMS-PIN per Webhook empfangen: ${pin}`);
        } else {
          logInfo('Webhook erhalten, aber keine PIN gefunden.');
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    } catch (err) {
      logError('Fehler im Webhook-Handler.', err);
      res.statusCode = 500;
      res.end();
    }
  });

  server.listen(config.port, () => {
    smsServerStarted = true;
    logInfo(
      `SMS-Webhooks aktiv auf http://0.0.0.0:${config.port}${config.path}`
    );
  });
}

async function waitForPin(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (pinQueue.length > 0) {
        const pin = pinQueue.shift();
        resolve(pin);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

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

  const envUser = process.env.CMX_USERNAME || process.env.CMX_USER;
  const envPass = process.env.CMX_PASSWORD || process.env.CMX_PASS;
  const envLoginUrl = process.env.CMX_LOGIN_URL || null;
  const envPin = process.env.CMX_PIN || null;
  const envPhone = process.env.CMX_PHONE || null;

  if (hasAuth) {
    logInfo(`Lade Auth- und Cookie-Daten aus ${AUTH_FILE}`);
    const raw = await readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : parsed;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('auth.json enthält keine Cookies (Feld "cookies").');
    }

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

  logInfo('auth.json nicht gefunden. Erzeuge Basisdatei.');

  const bootstrapLogin =
    envUser && envPass
      ? {
          username: envUser,
          password: envPass,
          loginUrl: envLoginUrl,
          pin: envPin,
          phone: envPhone
        }
      : null;

  const emptyAuth = {
    adminNotificationEmail: null,
    login: bootstrapLogin,
    cookies: []
  };

  await writeFile(AUTH_FILE, JSON.stringify(emptyAuth, null, 2), 'utf8');
  logInfo(
    `Basisdatei erstellt: ${AUTH_FILE}. Bitte ggf. Zugangsdaten in .env setzen.`
  );

  return { cookies: [], adminEmail: null, login: bootstrapLogin };
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

async function writeCoursesConfig(courses, defaultTriggerStatus) {
  if (!Array.isArray(courses) || courses.length === 0) return;

  const doc = {
    defaultTriggerStatus: defaultTriggerStatus || CANCELLED_STATUS,
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      triggerStatus: c.triggerStatus || undefined
    }))
  };

  const yamlText = yaml.dump(doc, { lineWidth: 120 });
  await writeFile(COURSES_FILE, yamlText, 'utf8');
  logInfo(`courses.yml aktualisiert (${courses.length} Kurse).`);
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

async function loadHistory() {
  if (!(await fileExists(HISTORY_FILE))) {
    return {};
  }
  try {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // ignore parse errors, start fresh
  }
  return {};
}

async function saveHistory(history) {
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

async function recordHistory(courseKey, status, appointments) {
  const history = await loadHistory();
  const entry = {
    ts: new Date().toISOString(),
    status: status || 'unknown',
    appointments: Array.isArray(appointments) ? appointments : []
  };
  const existing = Array.isArray(history[courseKey]) ? history[courseKey] : [];
  const updated = [...existing, entry].slice(-10);
  history[courseKey] = updated;
  await saveHistory(history);
}

function parseAppointmentDate(appointmentText) {
  if (!appointmentText) return null;
  const dateMatch = appointmentText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!dateMatch) return null;
  const [, dStr, mStr, yStr] = dateMatch;
  const day = Number(dStr);
  const month = Number(mStr);
  const year = Number(yStr);
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1900 ||
    year > 2100
  ) {
    return null;
  }
  const timeMatch = appointmentText.match(/(\d{1,2}):(\d{2})/);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function filterAppointments(appointments, { futureOnly = false } = {}) {
  if (!Array.isArray(appointments) || appointments.length === 0) return [];
  const now = new Date();
  return appointments
    .map((a) => (a || '').trim())
    .filter(Boolean)
    .filter((a) => {
      const dt = parseAppointmentDate(a);
      if (!dt) return false;
      if (futureOnly) return dt > now;
      return true;
    });
}

function buildInstructorConfig() {
  const envName = process.env.CMX_INSTRUCTOR_NAME || '';
  const envUrl = process.env.CMX_INSTRUCTOR_URL || '';
  const name = envName.trim();
  const listUrl = envUrl.trim();
  return { name, listUrl };
}

async function promptInstructorName() {
  const name = await promptInput('Honorarkraft-Name für Filter (Substring): ');
  return name && name.trim() ? name.trim() : null;
}

async function ensureInstructorConfig() {
  const cfg = buildInstructorConfig();
  if (cfg.name || cfg.listUrl) return cfg;
  const prompted = await promptInstructorName();
  return { name: prompted || '', listUrl: '' };
}

async function getRecommendedCourses(
  scrapedCourses,
  appointmentsCache,
  page,
  currentCourseId,
  maxCount = 3
) {
  if (!Array.isArray(scrapedCourses) || scrapedCourses.length === 0) return [];

  const norm = (v) => (v || '').trim().toLowerCase();
  const currentNorm = norm(currentCourseId);

  const candidates = scrapedCourses.filter((c) => {
    // Kandidaten sind alle Kurse außer dem aktuellen; Detailabruf klärt Status.
    return true;
  });

  const picked = [];
  const seen = new Set();

  for (const c of candidates) {
    const key = norm(c.id) || norm(c.url);
    if (!key || seen.has(key)) continue;
    if (currentNorm && (key === currentNorm || norm(c.url) === currentNorm)) {
      continue;
    }
    seen.add(key);

    let appointmentsForCourse =
      appointmentsCache.get(c.id) || appointmentsCache.get(c.url) || [];
    let statusLower = (c.status || '').trim().toLowerCase();

    const isLikelyCandidate =
      !statusLower ||
      statusLower === 'unknown' ||
      statusLower === 'in durchführung' ||
      statusLower === 'in durchfuehrung';

    if (!isLikelyCandidate && appointmentsForCourse.length === 0) {
      continue;
    }

    const shouldLoadDetails =
      !statusLower ||
      statusLower === 'unknown' ||
      appointmentsForCourse.length === 0;

    if (shouldLoadDetails) {
      const detail = await extractStatusAndAppointments(page, c.url);
      appointmentsForCourse = filterAppointments(detail.appointments || []);
      if (appointmentsForCourse.length > 0) {
        appointmentsCache.set(c.id, appointmentsForCourse);
        appointmentsCache.set(c.url, appointmentsForCourse);
      }
      if (detail.statusText) {
        c.status = detail.statusText;
        statusLower = detail.statusText.trim().toLowerCase();
      }
    } else {
      appointmentsForCourse = filterAppointments(appointmentsForCourse);
      if (appointmentsForCourse.length > 0) {
        appointmentsCache.set(c.id, appointmentsForCourse);
        appointmentsCache.set(c.url, appointmentsForCourse);
      }
    }

    const isInProgress =
      statusLower === 'in durchführung' ||
      statusLower === 'in durchfuehrung';
    const futureAppointments = filterAppointments(appointmentsForCourse, {
      futureOnly: true
    });
    if (!isInProgress || futureAppointments.length === 0) continue;

    if (futureAppointments.length !== appointmentsForCourse.length) {
      appointmentsCache.set(c.id, futureAppointments);
      appointmentsCache.set(c.url, futureAppointments);
    }

    picked.push({
      name: c.name,
      url: c.url,
      appointments: futureAppointments
    });

    if (picked.length >= maxCount) break;
  }

  return picked;
}

async function extractInstructorCourses(page, instructorConfig) {
  const targetUrl =
    instructorConfig.listUrl ||
    'https://vhs-lahnstein.de/App%20Veranstaltungen';

  logInfo(`Lade Veranstaltungsübersicht: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2' });

  const tableRowSelector =
    '#gridcmx_4d6ff7ab961dd tbody tr, table.report tbody tr';
  await page.waitForSelector('body', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector(tableRowSelector, { timeout: 12000 }).catch(() => {});

  const instructorNameRaw = (instructorConfig.name || '').trim();
  const instructorName = instructorNameRaw.toLowerCase();

  const getRowCount = async () =>
    page.$$eval(tableRowSelector, (rows) => rows.length).catch(() => 0);

  let rowCountBefore = await getRowCount();

  // Zuerst die Anzeige auf möglichst viele Zeilen setzen,
  // damit der clientseitige Filter nicht nur die erste Seite durchsucht.
  try {
    const limitChanged = await page.evaluate(() => {
      const select = document.querySelector('.controlbarZeilenanzahl select');
      if (!select) return false;
      select.value = '5000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if (limitChanged) {
      await page
        .waitForFunction(
          (sel, before) => document.querySelectorAll(sel).length >= before,
          { timeout: 8000 },
          tableRowSelector,
          rowCountBefore
        )
        .catch(() => page.waitForTimeout(1500));
      rowCountBefore = await getRowCount();
    }
  } catch {
    // ignore
  }

  // Serverseitig nach Honorarkraft filtern, falls möglich
  if (instructorName) {
    try {
      const filterApplied = await page.evaluate((nameLower, nameRaw) => {
        const candidates = [
          '#filterbox_cmx_4d6ff7ab961ddcmx64b795bf18715', // Honorarkraft
          'input[id*="filterbox"][id*="Kontakt"]',
          'input[id*="filterbox"][id*="honorar"]',
          'input[id*="filterbox"][id*="kontakt"]'
        ];
        const input = candidates
          .map((sel) => document.querySelector(sel))
          .find(Boolean);
        if (!input) return false;
        input.value = nameRaw || nameLower;
        const enterEvt = new KeyboardEvent('keyup', {
          key: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        input.dispatchEvent(enterEvt);
        if (
          typeof window.report_cmx_4d6ff7ab961dd?.SendSearch === 'function'
        ) {
          window.report_cmx_4d6ff7ab961dd.SendSearch(
            'https://vhs-lahnstein.de/index.php?seite=App Veranstaltungen&cmx_reportautowert=cmx_4d6ff7ab961dd&cmx_zielbereichsid=reportgridcmx_4d6ff7ab961dd'
          );
        }
        return true;
      }, instructorName, instructorNameRaw);
      if (filterApplied) {
        logInfo('Honorarkraft-Filter gesetzt, warte auf Aktualisierung...');
        await page
          .waitForFunction(
            (sel, before) => document.querySelectorAll(sel).length !== before,
            { timeout: 10000 },
            tableRowSelector,
            rowCountBefore
          )
          .catch(() => page.waitForTimeout(1200));
      }
    } catch {
      // falls Filter nicht gefunden, weiter mit clientseitigem Filter
    }
  }

  const { courses, totalRows, matchedRows } = await page.evaluate((filterName) => {
    const rows = Array.from(
      document.querySelectorAll('#gridcmx_4d6ff7ab961dd tbody tr, table.report tbody tr')
    );
    const result = [];
    let matched = 0;
    for (const row of rows) {
      const honorarCell = row.querySelector('.Kontakt_1_autowert');
      const honorarText = (honorarCell?.innerText || '').toLowerCase().trim();
      if (filterName && !honorarText.includes(filterName)) {
        continue;
      }
      matched += 1;

      const link =
        row.querySelector('.Veranstaltung_1_autowert a') ||
        row.querySelector('a.reportlink');
      const name = (link?.innerText || '').replace(/\s+/g, ' ').trim();
      const href = link?.getAttribute('href') || '';
      if (!href || !name) continue;

      const statusCell = row.querySelector('.Veranstaltung_1_mf_status');
      const status = (statusCell?.innerText || '').trim();
      const phaseCell = row.querySelector('.Veranstaltung_1_phase');
      const phase = (phaseCell?.innerText || '').trim();

      const idMatch = href.match(/cmx([a-z0-9]+)\.html/i);
      const courseId = idMatch ? `cmx${idMatch[1]}` : href;

      const absUrl = href.startsWith('http')
        ? href
        : new URL(href, 'https://vhs-lahnstein.de/').toString();

      result.push({
        id: courseId,
        name,
        url: absUrl,
        status,
        phase
      });
    }
    return { courses: result, totalRows: rows.length, matchedRows: matched };
  }, instructorName);

  logInfo(
    `Veranstaltungszeilen gesamt: ${totalRows || 0}, passend zum Filter: ${
      matchedRows || 0
    }`
  );

  if (!courses || courses.length === 0 || (matchedRows || 0) === 0) {
    logInfo('Keine Kurse für die Honorarkraft gefunden (Filter ggf. anpassen).');
    return [];
  }

  // Deduplizieren nach id
  const map = new Map();
  for (const c of courses) {
    if (!map.has(c.id)) map.set(c.id, c);
  }
  const uniqueCourses = Array.from(map.values());
  logInfo(`Gefundene Kurse für Honorarkraft: ${uniqueCourses.length}`);
  return uniqueCourses;
}

function logCourseOverview(courses) {
  if (!Array.isArray(courses) || courses.length === 0) {
    logInfo('Keine Kurse zur Anzeige vorhanden.');
    return;
  }
  logInfo('Kursübersicht (gefiltert):');
  courses.forEach((c, idx) => {
    logInfo(
      `${idx + 1}. ${c.id} | ${c.name} | Status: ${c.status || '-'} | Phase: ${
        c.phase || '-'
      } | ${c.url}`
    );
  });
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

async function createPageWithDefaults(browser) {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
        return req.abort();
      }
      return req.continue();
    });
  } catch {
    // Falls Interception nicht verfügbar ist, einfach weiter
  }
  return page;
}

async function setupBrowserWithCookies(cookies) {
  const headlessEnv = (process.env.CMX_HEADLESS || '').toLowerCase();
  const headless =
    headlessEnv === 'false' ? false : headlessEnv === 'true' ? 'new' : 'new';
  const slowMo = process.env.CMX_SLOWMO ? Number(process.env.CMX_SLOWMO) : 0;
  const devtools = (process.env.CMX_DEVTOOLS || '').toLowerCase() === 'true';

  logInfo(`Starte Puppeteer (${headless === false ? 'headed' : 'headless'}).`);
  const browser = await puppeteer.launch({
    headless,
    slowMo,
    devtools,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await createPageWithDefaults(browser);

  const cookieObjects = cookies.map((c) => {
    const { name, value, domain, path: cookiePath, httpOnly, secure } = c;
    const result = { name, value };
    if (domain) result.domain = domain;
    if (cookiePath) result.path = cookiePath;
    if (typeof httpOnly === 'boolean') result.httpOnly = httpOnly;
    if (typeof secure === 'boolean') result.secure = secure;
    return result;
  });

  if (cookieObjects.length > 0) {
    logInfo('Setze Cookies für vhs-lahnstein.de.');
    await page.setCookie(...cookieObjects);
  } else {
    logInfo('Keine Cookies vorhanden, überspringe Setzen von Cookies.');
  }

  return { browser, page };
}

async function tryLoginOnPage(page, loginConfig) {
  if (!loginConfig || !loginConfig.username || !loginConfig.password) {
    return { success: false, reason: 'No credentials provided' };
  }

  const findFirstHandle = async (selectors) => {
    for (const sel of selectors) {
      const handle = await page.$(sel);
      if (handle) return { handle, selector: sel };
    }
    return null;
  };

  const fillInput = async (selector, value) => {
    const handle = await page.$(selector);
    if (!handle) return false;
    await handle.click({ clickCount: 3 });
    await handle.press('Backspace');
    await page.type(selector, value, { delay: 20 });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);
    return true;
  };

  const clickSubmit = async () => {
    const submitSelectors = [
      '#subbut',
      'button[type="submit"]',
      'input[type="submit"]',
      'button[name="login"]',
      'input[name="login"][type="button"]'
    ];

    for (const sel of submitSelectors) {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click();
        return true;
      }
    }

    // Fallback: suche Button per Textinhalt
    const clickedByText = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, input[type="button"], input[type="submit"]')
      );
      const target = candidates.find((btn) =>
        /login|anmelden|anmeldung|sign in/i.test(
          (btn.textContent || btn.value || '')
        )
      );
      if (target) {
        (target instanceof HTMLElement ? target : target.parentElement)?.click();
        return true;
      }
      return false;
    });
    if (clickedByText) return true;

    return false;
  };

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
    return { success: false, reason: 'Login form not found' };
  }

  const userSelectors = [
    '#login',
    'input[name="login"]',
    'input[type="email"]',
    'input[name*="user"]',
    'input[id*="user"]',
    'input[name*="mail"]',
    'input[id*="mail"]',
    'input[type="text"]',
    'input:not([type])'
  ];
  const passSelectors = [
    '#passwort',
    'input[name="passwort"]',
    'input[type="password"]'
  ];

  const userInput = await findFirstHandle(userSelectors);
  const passInput = await findFirstHandle(passSelectors);

  if (!userInput || !passInput) {
    logInfo('Login-Inputs nicht gefunden.');
    return { success: false, reason: 'Login inputs missing' };
  }

  await fillInput(userInput.selector, loginConfig.username);
  await fillInput(passInput.selector, loginConfig.password);

  // Stay logged in, wenn vorhanden
  const staySelectors = ['#stay', 'input[name="stay"]'];
  for (const sel of staySelectors) {
    const handle = await page.$(sel);
    if (handle) {
      const checked = await page.evaluate(
        (s) => {
          const el = document.querySelector(s);
          if (!el || !(el instanceof HTMLInputElement)) return false;
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return el.checked;
        },
        sel
      );
      if (checked) break;
    }
  }

  const submissionTriggered = await clickSubmit();

  if (!submissionTriggered) {
    logInfo('Login-Formular konnte nicht bedient werden (kein Submit-Button).');
    return { success: false, reason: 'Login form could not be submitted' };
  }

  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 });
  } catch {
    // ignore
  }

  const pinVisible = await page.evaluate(() => {
    const pinInput =
      document.querySelector('#pin') ||
      document.querySelector('input[name="pin"]') ||
      document.querySelector('input[type="pin"]');
    if (!pinInput) return false;
    const style = window.getComputedStyle(pinInput);
    return style && style.display !== 'none' && style.visibility !== 'hidden';
  });

  if (pinVisible) {
    if (!loginConfig.pin) {
      logInfo('2FA-PIN erforderlich, aber keine PIN hinterlegt.');
      return {
        success: false,
        reason: '2FA PIN required',
        requiresPin: true
      };
    }

    const secondSubmit = await page.evaluate(
      ({ pin }) => {
        const pinInput =
          document.querySelector('#pin') ||
          document.querySelector('input[name="pin"]') ||
          document.querySelector('input[type="pin"]');
        if (!pinInput) return false;
        pinInput.value = pin;

        const form = pinInput.form;
        if (form) {
          form.submit();
          return true;
        }
        const submitButton =
          document.querySelector('#subbut') ||
          document.querySelector('button[type="submit"]') ||
          Array.from(
            document.querySelectorAll('button,input[type="submit"]')
          ).find((btn) =>
            /login|anmelden|anmeldung|sign in|weiter|senden/i.test(
              (btn.textContent || btn.value || '')
            )
          );
        if (submitButton) {
          submitButton.click();
          return true;
        }
        return false;
      },
      { pin: loginConfig.pin }
    );

    if (!secondSubmit) {
      logInfo('PIN-Eingabe konnte nicht abgesendet werden.');
      return { success: false, reason: 'PIN submit failed' };
    }

    try {
      await page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 12000
      });
    } catch {
      // ignore
    }
  }

  // Prüfen, ob Login-Formular verschwunden ist
  const stillOnLogin = await page.evaluate(() => {
    return Boolean(
      document.querySelector('input[type="password"]') ||
        document.querySelector('form[action*="Login"], form[action*="login"]')
    );
  });

  if (stillOnLogin) {
    return { success: false, reason: 'Login form still present after submit' };
  }

  return { success: true };
}

async function promptInput(question) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

async function submitPinOnly(page, pin) {
  const pinSelectors = [
    '#pin',
    'input[name="pin"]',
    'input[type="pin"]',
    'input[name*="pin"]',
    'input[name*="2fa"]',
    'input[type="text"]',
    'input[type="tel"]'
  ];

  const submitSelectors = [
    '#subbut',
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name="login"]',
    'input[name="login"][type="button"]',
    'button[name*="weiter"]',
    'input[name*="weiter"]'
  ];

  const findFirstHandle = async (selectors) => {
    for (const sel of selectors) {
      const handle = await page.$(sel);
      if (handle) return { handle, selector: sel };
    }
    return null;
  };

  const fillInput = async (selector, value) => {
    const handle = await page.$(selector);
    if (!handle) return false;
    await handle.click({ clickCount: 3 });
    await handle.press('Backspace');
    await page.type(selector, value, { delay: 20 });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);
    return true;
  };

  const clickSubmit = async () => {
    for (const sel of submitSelectors) {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click();
        return true;
      }
    }

    const clickedByText = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, input[type="button"], input[type="submit"]')
      );
      const target = candidates.find((btn) =>
        /login|anmelden|anmeldung|sign in|weiter|senden|ok/i.test(
          (btn.textContent || btn.value || '')
        )
      );
      if (target) {
        (target instanceof HTMLElement ? target : target.parentElement)?.click();
        return true;
      }
      return false;
    });
    return clickedByText;
  };

  const pinInput = await findFirstHandle(pinSelectors);
  if (!pinInput) {
    return { success: false, reason: 'PIN input not found' };
  }

  await fillInput(pinInput.selector, pin);

  const submitted = await clickSubmit();

  if (!submitted) {
    return { success: false, reason: 'PIN submit button not found' };
  }

  try {
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 12000
    });
  } catch {
    // ignore navigation timeout; fall back to DOM check
  }

  const stillOnLogin = await page.evaluate(() => {
    const hasLoginForm = Boolean(
      document.querySelector('input[type="password"]') ||
        document.querySelector('form[action*="Login"], form[action*="login"]')
    );
    const hasPinForm = Boolean(
      document.querySelector('#pin') ||
        document.querySelector('input[name="pin"]') ||
        document.querySelector('input[type="pin"]')
    );
    return hasLoginForm || hasPinForm;
  });

  if (stillOnLogin) {
    return { success: false, reason: 'Login form still present after PIN' };
  }

  return { success: true };
}

async function attemptLoginAndRefresh(page, loginConfig, adminEmail) {
  const result = await tryLoginOnPage(page, loginConfig);
  if (!result.success) {
    if (result.requiresPin) {
      logInfo(
        `2FA erforderlich. Bitte SMS-Code eingeben (Telefon: ${
          loginConfig.phone || 'nicht gesetzt'
        }).`
      );
      const webhookConfig = getWebhookConfig();
      let pinInput = null;

      if (webhookConfig) {
        logInfo(
          `Warte auf SMS-PIN per Webhook (Timeout ${webhookConfig.timeoutMs} ms).`
        );
        pinInput = await waitForPin(webhookConfig.timeoutMs);
      }

      if (!pinInput) {
        if (!loginConfig.phone) {
          const phoneValue = await promptInput('Mobilnummer für SMS-Empfang: ');
          if (phoneValue && phoneValue.trim()) {
            loginConfig.phone = phoneValue.trim();
          }
        }
        const pinPrompt = await promptInput('2FA-PIN aus SMS: ');
        if (!pinPrompt || !pinPrompt.trim()) {
          return {
            success: false,
            reason: '2FA PIN required but not provided by user'
          };
        }
        pinInput = pinPrompt.trim();
      }

      const pinSubmitResult = await submitPinOnly(page, pinInput.trim());
      if (!pinSubmitResult.success) {
        logInfo(
          `PIN-Submit fehlgeschlagen. Grund: ${
            pinSubmitResult.reason || 'unbekannt'
          }`
        );
        return pinSubmitResult;
      }
      loginConfig.pin = pinInput.trim();
    } else {
      logInfo(
        `Auto-Login fehlgeschlagen oder nicht möglich. Grund: ${result.reason || 'unbekannt'}`
      );
      return { success: false, reason: result.reason || 'Login failed' };
    }
  }

  const newCookies = await page.cookies();
  await saveAuth({
    adminNotificationEmail: adminEmail,
    login: loginConfig,
    cookies: newCookies
  });
  logInfo('Login erfolgreich, Cookies erneuert und gespeichert.');
  return { success: true };
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
  const loginResult = await attemptLoginAndRefresh(
    page,
    auth.login,
    auth.adminEmail
  );

  if (loginResult.success) {
    logInfo('Auto-Login erfolgreich, Session erneuert.');
    return { browser, page };
  }

  await sendAdminNotification(smtpConfig, auth.adminEmail, {
    courseName: 'SESSION_CHECK',
    courseId: 'SESSION_CHECK',
    courseUrl: targetUrl,
    reason:
      loginResult.reason ||
      'Login fehlgeschlagen: Cookies ungültig, Auto-Login nicht möglich.',
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

    // Versuche, die konkreten Terminzeilen einzusammeln (Kontext: Kufer/CMX)
    const datePattern = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/;
    const timePattern = /\b\d{1,2}:\d{2}\b/;

    const collected = new Set();

    const addAppointment = (date, from, to, raw) => {
      const parts = [];
      if (date) parts.push(date);
      if (from) parts.push(from);
      if (to) parts.push(to);
      const text = parts.join(' ').trim() || raw;
      if (text) collected.add(text.replace(/\s+/g, ' ').trim());
    };

    // 1) Bevorzugt Tabellenzeilen mit Datum/Zeit
    const rows = Array.from(document.querySelectorAll('table tr'));
    for (const row of rows) {
      const cellsText = Array.from(row.querySelectorAll('td, th'))
        .map((c) => (c.innerText || c.textContent || '').trim())
        .filter(Boolean)
        .join(' ');
      if (!cellsText) continue;
      const dateMatch = cellsText.match(datePattern);
      const times = cellsText.match(new RegExp(timePattern, 'g')) || [];
      if (dateMatch) {
        const date = dateMatch[0];
        if (times.length >= 2) {
          addAppointment(date, times[0], times[1], cellsText);
        } else if (times.length === 1) {
          addAppointment(date, times[0], null, cellsText);
        } else {
          addAppointment(date, null, null, cellsText);
        }
      }
    }

    // 2) Fallback auf Elemente mit Termin-Bezug
    if (collected.size === 0) {
      const nodes = document.querySelectorAll(
        '[class*="termin"], [id*="termin"], li, p, span, div'
      );
      nodes.forEach((node) => {
        const text = (node.innerText || node.textContent || '').trim();
        if (!text) return;
        const dateMatch = text.match(datePattern);
        if (!dateMatch) return;
        const times = text.match(new RegExp(timePattern, 'g')) || [];
        if (times.length >= 2) {
          addAppointment(dateMatch[0], times[0], times[1], text);
        } else if (times.length === 1) {
          addAppointment(dateMatch[0], times[0], null, text);
        } else {
          addAppointment(dateMatch[0], null, null, text);
        }
      });
    }

    return {
      statusText,
      appointments: Array.from(collected).slice(0, 20),
      notLoggedIn: Boolean(hasLoginForm)
    };
  });

  const rawAppointments = Array.isArray(appointments) ? appointments : [];
  const cleanAppointments = filterAppointments(rawAppointments);

  logInfo(`Aktueller Status der Veranstaltung: ${statusText}`);
  logInfo(
    `Gefundene Termine für Veranstaltung (bereinigt): ${cleanAppointments.length}` +
      (rawAppointments.length && rawAppointments.length !== cleanAppointments.length
        ? ` von ${rawAppointments.length}`
        : '')
  );
  if (notLoggedIn) {
    logInfo('Login-Formular entdeckt, Cookies vermutlich abgelaufen.');
  }
  return { statusText, appointments: cleanAppointments, notLoggedIn };
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

  const page = await createPageWithDefaults(browser);

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

    const contactPage = await createPageWithDefaults(browser);

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
    const appointmentsArray = filterAppointments(
      Array.isArray(courseContext.appointments)
        ? courseContext.appointments
        : []
    );
    const appointmentsText = appointmentsArray
      .map((a) => `- ${a}`)
      .join('\n');
    const recommendedCoursesText = courseContext.recommendedCoursesText || '';
    const instructorProfileUrl =
      (courseContext.instructorProfileUrl || '').trim();

    const context = {
      participantFirstName: participant.firstName || '',
      participantLastName: participant.lastName || '',
      courseName: courseContext.name || '',
      courseId: courseContext.id || '',
      courseUrl: courseContext.url || '',
      courseStatus: courseContext.status || '',
      appointments: appointmentsArray.join(', '),
      appointmentsText,
      instructorProfileUrl,
      recommendedCoursesText
    };

    const subject = renderTemplate(selectedTemplate.subject, context);
    let text = renderTemplate(selectedTemplate.text, context);

    if (instructorProfileUrl) {
      const footerTemplate =
        typeof selectedTemplate.footer === 'string'
          ? selectedTemplate.footer
          : null;
      const renderedFooter = footerTemplate
        ? renderTemplate(footerTemplate, context)
        : `Weitere Kurse von mir: ${instructorProfileUrl}`;
      if (renderedFooter.trim()) {
        text += `\n\n${renderedFooter.trim()}`;
      }
    }

    if (recommendedCoursesText) {
      text += `\n\nMeine nächsten Kurse:\n${recommendedCoursesText}`;
    }

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
    startSmsWebhookServer();

    const auth = await loadAuth();
    const statusMap = await loadStatusMap();
    const smtpConfig = await loadSmtpConfig();
    const emailTemplates = await loadEmailTemplates();

    const cookies = auth.cookies;
    const adminEmail = auth.adminEmail;
    const login = auth.login;

    const probeUrl = (login && login.loginUrl) || 'https://vhs-lahnstein.de/';

    const session = await ensureSession(
      { cookies, adminEmail, login },
      smtpConfig,
      probeUrl
    );
    browser = session.browser;
    const page = session.page;

    // Kurse für Honorarkraft ermitteln und courses.yml befüllen
    const instructorCfg = await ensureInstructorConfig();
    const scrapedCourses = await extractInstructorCourses(page, instructorCfg);
    const defaultTriggerFromEnv =
      (process.env.CMX_DEFAULT_TRIGGER_STATUS || '').trim() || null;

    const normalizeId = (v) => (v || '').trim();
    const idFromUrl = (u) => {
      const match = (u || '').match(/cmx[0-9a-f]+/i);
      return match ? match[0] : (u || '').trim();
    };

    // Lookup für spätere Status-Verwendung (Listenstatus)
    const scrapedByKey = new Map();
    for (const c of scrapedCourses) {
      const keyId = normalizeId(c.id);
      const keyUrl = normalizeId(c.url);
      const shortId = idFromUrl(c.url);
      [keyId, keyUrl, shortId].forEach((k) => {
        if (k && !scrapedByKey.has(k)) scrapedByKey.set(k, c);
      });
    }

    if (scrapedCourses.length > 0) {
      logCourseOverview(scrapedCourses);
      await writeCoursesConfig(scrapedCourses, defaultTriggerFromEnv);
    } else {
      logInfo('Keine neuen Kurse gefunden, courses.yml wird nicht überschrieben.');
    }

    const coursesConfig = await loadCoursesConfig();

    const summary = {
      totalCourses: coursesConfig.courses.length,
      relevantChanges: 0,
      notifiedParticipants: 0
    };
    const appointmentsCache = new Map();

    for (const course of coursesConfig.courses) {
      const courseKey = getCourseKey(course);
      const scraped =
        scrapedByKey.get(courseKey) ||
        scrapedByKey.get(course.url) ||
        scrapedByKey.get((course.url && course.url.trim()) || '') ||
        scrapedByKey.get((course.id && course.id.trim()) || '');
      const triggerStatus =
        (course.triggerStatus &&
          typeof course.triggerStatus === 'string' &&
          course.triggerStatus.trim()) ||
        coursesConfig.defaultTriggerStatus ||
        CANCELLED_STATUS;

      let currentStatus =
        scraped && scraped.status && scraped.status.trim()
          ? scraped.status.trim()
          : null;
      let appointments = [];
      let notLoggedIn = false;

      logInfo(
        `Verarbeite Kurs ${courseKey} (${course.name || 'ohne Namen'}) mit Trigger-Status "${triggerStatus}".`
      );

      const lastStatusForCourse = getLastStatusForCourse(statusMap, courseKey);

      if (!currentStatus) {
        ({
          statusText: currentStatus,
          appointments,
          notLoggedIn
        } = await withRetry(
          () => extractStatusAndAppointments(page, course.url),
          `Status der Veranstaltung (${courseKey}) ermitteln`
        ));
        appointments = filterAppointments(appointments);
      }

      let statusUnknown = currentStatus === 'unknown' || !currentStatus;

      // Falls nicht eingeloggt oder unbekannter Status: einmal autorisierter Login-Versuch und erneute Status-Ermittlung
      if ((statusUnknown || notLoggedIn) && login) {
        const loginResult = await attemptLoginAndRefresh(
          page,
          login,
          adminEmail
        );
        if (loginResult.success) {
          const retry = await withRetry(
            () => extractStatusAndAppointments(page, course.url),
            `Status der Veranstaltung nach Login (${courseKey}) ermitteln`
          );
          currentStatus = retry.statusText;
          appointments = retry.appointments;
          appointments = filterAppointments(appointments);
          notLoggedIn = retry.notLoggedIn;
          statusUnknown = currentStatus === 'unknown';
        } else {
          logInfo(
            `Login-Retry im Kurslauf fehlgeschlagen. Grund: ${
              loginResult.reason || 'unbekannt'
            }`
          );
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
        await recordHistory(courseKey, currentStatus, appointments);
        continue;
      }

      appointments = filterAppointments(appointments);

      if (appointments && appointments.length > 0) {
        appointmentsCache.set(courseKey, appointments);
        appointmentsCache.set(course.url, appointments);
      }

      const statusChangedToTrigger =
        currentStatus === triggerStatus &&
        lastStatusForCourse !== triggerStatus;

      // Wenn der Status nicht aus der Liste kam oder wir Termine brauchen, nur bei Änderung Detailseite laden.
      if (statusChangedToTrigger && appointments.length === 0) {
        ({
          statusText: currentStatus,
          appointments,
          notLoggedIn
        } = await withRetry(
          () => extractStatusAndAppointments(page, course.url),
          `Status der Veranstaltung (${courseKey}) ermitteln (Detail)`
        ));
        appointments = filterAppointments(appointments);
        if (appointments && appointments.length > 0) {
          appointmentsCache.set(courseKey, appointments);
          appointmentsCache.set(course.url, appointments);
        }
      }

      if (!statusChangedToTrigger) {
        logInfo(
          `Kein relevanter Statuswechsel für Kurs ${courseKey}. Vorher: "${lastStatusForCourse}", jetzt: "${currentStatus}".`
        );
        setLastStatusForCourse(statusMap, courseKey, currentStatus);
        await recordHistory(courseKey, currentStatus, appointments);
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

      const statusTemplate = emailTemplates.default;

      const recommendedCourses = await getRecommendedCourses(
        scrapedCourses,
        appointmentsCache,
        page,
        courseKey,
        3
      );
      const recommendedCoursesText = recommendedCourses
        .map((c) => {
          const appts =
            Array.isArray(c.appointments) && c.appointments.length > 0
              ? `\n  Termine:\n  ${c.appointments
                  .map((a) => `- ${a}`)
                  .join('\n  ')}`
              : '';
          return `- ${c.name} (${c.url})${appts}`;
        })
        .join('\n');

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
            : '',
          instructorProfileUrl: INSTRUCTOR_PROFILE_URL,
          recommendedCoursesText
        }
      );

      setLastStatusForCourse(statusMap, courseKey, currentStatus);
      await recordHistory(courseKey, currentStatus, appointments);

      summary.relevantChanges += 1;
      summary.notifiedParticipants += participantsWithEmail.length;
    }

    await saveStatusMap(statusMap);

    logInfo(
      `Zusammenfassung: Veranstaltungen gesamt: ${summary.totalCourses}, ` +
        `relevante Statusänderungen: ${summary.relevantChanges}, ` +
        `benachrichtigte Teilnehmer: ${summary.notifiedParticipants}`
    );

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
