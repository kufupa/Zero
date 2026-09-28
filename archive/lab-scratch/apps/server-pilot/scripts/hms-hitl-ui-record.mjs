/**
 * HITL visual packaging: UI-first Playwright record.
 * Last painted frame must show owner surface. Soft-XHR-only is FAIL.
 *
 * HMS_HITL_TOOL=A2|A3|A5|A6|A8|A9
 * HMS_DISCOVERY_ALLOW_LIVE=1
 * HMS_READ_SECRET_ARN + HMS_PROOF_EXACT_CANDIDATE_PATH
 * Digests/codes only on stdout. No confirmation/PII.
 */
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";

const execFileP = promisify(execFile);
const HOLD_PAINTED_MS = 20_000;
const HITL_TAIL_SEC = 20;
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
    .replace(/\b\d{7,}\b/g, "[n]");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadSecret() {
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error("missing HMS_READ_SECRET_ARN");
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "af-south-1",
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = JSON.parse(res.SecretString);
  if (!secret.loginUrl || !secret.username || !secret.password) {
    throw new Error("secret shape");
  }
  return secret;
}

async function loadConfirm() {
  const p = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!p) return "";
  const j = JSON.parse(await readFile(p, "utf8"));
  return String(j.value || j.confirmation || j.confirmationNumber || "");
}

async function clickText(page, label, { hover = false, timeout = 4000 } = {}) {
  return page.evaluate(
    ({ label, hover }) => {
      const nodes = [
        ...document.querySelectorAll(
          ".x-menu-item-text, .x-btn-inner, a, span, button, .x-tab-inner, .x-tab",
        ),
      ];
      const el = nodes.find((n) => (n.textContent || "").trim() === label);
      if (!el) return false;
      if (hover) {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      }
      el.click();
      return true;
    },
    { label, hover },
  );
}

async function waitNoSpinner(page, ms = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const busy = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return /Processing request/i.test(t);
    });
    if (!busy) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function snap(page) {
  return page.evaluate(() => {
    const url = location.href;
    const title = document.title || "";
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1200);
    const login = /logindisp|Sign in|userid/i.test(text) && /password/i.test(text);
    const processing = /Processing request/i.test(text);
    const startCenter = /Start Center/i.test(text) && /No KPIs available|Inbox/i.test(text);
    const err0 = /!\s*0\b|\b0\s+OK\b/i.test(text) && /OK/i.test(text);
    const tabs = [...document.querySelectorAll(".x-tab, .x-tab-strip-active, .x-tab-active")]
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 20);
    const activeTab =
      (
        document.querySelector(".x-tab-strip-active, .x-tab-active, .x-tab.x-tab-active")
          ?.textContent || ""
      ).trim() ||
      tabs.find((t) => /folio|notes|traces|record view|sent email/i.test(t)) ||
      "";
    return {
      urlHost: (() => {
        try {
          return new URL(url).host;
        } catch {
          return "";
        }
      })(),
      path: (() => {
        try {
          return new URL(url).pathname.slice(0, 80);
        } catch {
          return "";
        }
      })(),
      title: title.slice(0, 80),
      login,
      processing,
      startCenter,
      err0,
      activeTab: activeTab.slice(0, 80),
      tabs: tabs.slice(0, 12),
      hasFolioTab: tabs.some((t) => /^folio$/i.test(t)) || /Folio/.test(text),
      hasNotesTab: /Notes/.test(text),
      hasTracesTab: /Traces/.test(text),
      hasSentEmail: /All Sent Email|Email Type|Email Address/i.test(text),
      hasQuote: /Room Type and Rate Availability/i.test(text),
      hasQuoteGrid:
        /Room Type and Rate Availability/i.test(text) &&
        (/Records:\s*[1-9]/i.test(text) ||
          /Available|Occupancy|Allotment|Closed|Overbook/i.test(text)),
      hasAvailSummary: /AVAILABILITY SUMMARY/i.test(text),
      lookupOpen: /Arrivals\s+Departures\s+In-House/i.test(text),
      hasGroup: /Group Booking|Allotment|Block/i.test(text),
      hasOrg: /Organization Profile|Company/i.test(text),
      hasGuestStay: /Guest Stay/i.test(text),
      kpiZero: /No KPIs available/i.test(text),
      textSample: text
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
        .replace(/\b\d{7,}\b/g, "[n]")
        .slice(0, 400),
    };
  });
}

async function setActiveTab(page, title) {
  return page.evaluate((lab) => {
    const Ext = window.Ext;
    const panels = Ext?.ComponentQuery?.query("tabpanel") ?? [];
    for (const p of panels) {
      const items = p.items?.items ?? [];
      const item = items.find((i) => String(i.title ?? "") === lab);
      if (!item) continue;
      try {
        p.setActiveTab(item);
        return { ok: true, active: p.getActiveTab?.()?.title ?? lab };
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 80) };
      }
    }
    const el = [...document.querySelectorAll(".x-tab, .x-tab-inner, span, a")].find(
      (n) => (n.textContent || "").trim() === lab,
    );
    if (el) {
      el.click();
      return { ok: true, active: lab, via: "dom" };
    }
    return { ok: false, err: "notfound" };
  }, title);
}

async function dismissExt(page) {
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "OK",
    );
    if (ok) ok.click();
  });
  await page.waitForTimeout(400);
}

async function dismissStayLookup(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function holdPainted(page) {
  await waitNoSpinner(page, 25_000);
  await page.waitForTimeout(HOLD_PAINTED_MS);
}

async function login(page, secret) {
  await page.goto(secret.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .locator("input[name=userid], input[name=username], input[name=j_username]")
    .first()
    .fill(secret.username);
  await page.locator("input[name=password]").fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole("button", { name: "Sign in" }).click().catch(async () => {
      await page.locator("input[name=password]").press("Enter");
    }),
  ]);
  await page.waitForTimeout(8_000);
  if (!/COMMON/i.test(page.url())) {
    throw new Error(`no COMMON after login: ${page.url().slice(0, 40)}`);
  }
}

async function openMore(page) {
  await clickText(page, "More");
  await page.waitForTimeout(800);
}

async function menuSearch(page, query) {
  await openMore(page);
  await page.waitForTimeout(400);
  const typed = await page.evaluate((q) => {
    const Ext = window.Ext;
    const fields = Ext?.ComponentQuery?.query("textfield, field") ?? [];
    const f = fields.find((x) => String(x.name ?? "") === "appmenusearch");
    if (f?.setValue) {
      f.setValue(q);
      f.focus?.();
      f.fireEvent?.("change", f, q);
      return true;
    }
    const inp = document.querySelector('input[name=appmenusearch], input[placeholder*="Search this menu" i]');
    if (!inp) return false;
    inp.focus();
    inp.value = q;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, query);
  process.stdout.write(`HMS_HITL menuSearch typed=${typed} q=${query}\n`);
  await page.waitForTimeout(1500);
  const hit = await clickText(page, query);
  if (!hit) {
    await page.getByText(query, { exact: true }).first().click({ force: true, timeout: 4000 }).catch(() => undefined);
  }
  await page.waitForTimeout(8_000);
  return hit;
}

async function menuPath(page, labels) {
  await openMore(page);
  for (let i = 0; i < labels.length; i++) {
    const hover = i < labels.length - 1;
    const ok = await clickText(page, labels[i], { hover: true });
    process.stdout.write(`HMS_HITL nav=${labels[i]} hit=${ok} hover=${hover}\n`);
    await page.waitForTimeout(hover ? 1600 : 8000);
  }
}

async function fillHeaderSearch(page, confirm) {
  if (!confirm) return { filled: false };
  return page.evaluate((conf) => {
    const Ext = window.Ext;
    const fields = Ext?.ComponentQuery?.query("textfield, field") ?? [];
    const inv = fields
      .map((x) => ({
        name: String(x.name ?? "").slice(0, 40),
        itemId: String(x.itemId ?? "").slice(0, 40),
        label: String(x.fieldLabel ?? "").slice(0, 40),
        empty: String(x.emptyText ?? "").slice(0, 40),
      }))
      .filter((x) => x.name || x.itemId || x.label)
      .slice(0, 40);
    const prefer = (want) =>
      fields.find((x) => String(x.name ?? "") === want);
    const f =
      prefer("search") ||
      prefer("ff_confirmationnumber") ||
      fields.find((x) =>
        /search by name, confirmation/i.test(String(x.emptyText ?? "")),
      );
    if (f?.setValue) {
      f.setValue(conf);
      f.focus?.();
      return {
        filled: true,
        via: `ext-${String(f.name ?? "x")}`,
        inv,
      };
    }
    const run = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "Run",
    );
    const bar =
      run?.closest(".x-toolbar, .x-panel-header, .x-box-inner, header") ||
      document.body;
    const input = bar.querySelector("input.x-form-field, input[type=text]");
    if (!input) return { filled: false, inv };
    input.focus();
    input.value = conf;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, via: "dom-run-bar", inv };
  }, confirm);
}

async function recordCount(page) {
  return page.evaluate(() => {
    const t = document.body?.innerText || "";
    const m = /Records:\s*(\d+)\s+of\s+(\d+)/i.exec(t);
    return m ? { n: Number(m[1]), total: Number(m[2]) } : { n: -1, total: -1, t: t.slice(0, 80) };
  });
}

async function clickVisibleTab(page, title) {
  const clicked = await page.evaluate((lab) => {
    const tabs = [...document.querySelectorAll(".x-tab-inner, .x-tab span, .x-tab")];
    const el = tabs.find((n) => (n.textContent || "").trim() === lab);
    if (!el) return false;
    el.click();
    return true;
  }, title);
  if (!clicked) {
    await page.getByText(title, { exact: true }).first().click({ force: true, timeout: 5000 }).catch(() => undefined);
  }
  return setActiveTab(page, title);
}

async function openGuestStay(page, confirm) {
  await menuPath(page, ["Front Desk", "Guest Stay"]);
  await waitNoSpinner(page, 20_000);
  const fill = await fillHeaderSearch(page, confirm);
  process.stdout.write(
    `HMS_HITL fill via=${fill.via || "none"} nFields=${(fill.inv || []).length}\n`,
  );
  const ph = page.getByPlaceholder(/Search by Name, Confirmation/i).first();
  if (await ph.count()) {
    await ph.click({ force: true }).catch(() => undefined);
    await ph.fill(confirm);
    await ph.press("Enter");
    process.stdout.write("HMS_HITL placeholder search filled\n");
    await page.waitForResponse(
      (r) => r.request().method() === "POST" && /OSRESS\.search/i.test(r.url()),
      { timeout: 20_000 },
    ).catch(() => process.stdout.write("HMS_HITL no OSRESS.search xhr\n"));
  }
  await page.waitForTimeout(400);
  const headerBox = page.locator(".x-panel-header input.x-form-field, .x-toolbar input.x-form-field").first();
  if (await headerBox.count()) {
    await headerBox.fill(confirm).catch(() => undefined);
    await headerBox.press("Enter").catch(() => undefined);
    process.stdout.write("HMS_HITL headerBox fill attempted\n");
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_000);
  await clickText(page, "Run");
  await page.waitForTimeout(10_000);
  await waitNoSpinner(page, 20_000);
  let rec = await recordCount(page);
  process.stdout.write(`HMS_HITL records=${JSON.stringify({ n: rec.n, total: rec.total })}\n`);
  if (rec.n === 0 || rec.total === 0) {
    // Header search miss — try confirmation filter field only, never first input.
    await page.evaluate((conf) => {
      const Ext = window.Ext;
      const fields = Ext?.ComponentQuery?.query("textfield, field") ?? [];
      for (const f of fields) {
        const blob = String(f.name ?? f.itemId ?? f.fieldLabel ?? "");
        if (/^ff_confirmationnumber$/i.test(blob) && f.setValue) {
          f.setValue(conf);
        }
      }
    }, confirm);
    await clickText(page, "Run");
    await page.waitForTimeout(10_000);
    rec = await recordCount(page);
    process.stdout.write(`HMS_HITL records2=${JSON.stringify({ n: rec.n, total: rec.total })}\n`);
  }
  try {
    await page.locator(".x-grid-row, .x-grid3-row").first().dblclick({
      force: true,
      timeout: 8_000,
    });
  } catch {
    await page.evaluate(() => {
      const Ext = window.Ext;
      const gs = Ext?.ComponentQuery?.query("grid") ?? [];
      const grid = gs.find((g) => (g.store?.getCount?.() ?? 0) > 0);
      const view = grid?.getView?.();
      const node = view?.getNode?.(0);
      if (node) node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
  }
  await page.waitForTimeout(8_000);
  await waitNoSpinner(page, 30_000);
  await dismissStayLookup(page);
  const after = await snap(page);
  process.stdout.write(
    `HMS_HITL afterOpen login=${after.login} processing=${after.processing} active=${JSON.stringify(after.activeTab)} rec0=${/Records:\s*0 of 0/i.test(after.textSample)}\n`,
  );
}

function verdictFor(tool, s) {
  if (s.login) return { pass: false, code: "LOGIN_BOUNCE" };
  if (s.err0) return { pass: false, code: "EXT_ERROR_DIALOG" };
  if (s.processing) return { pass: false, code: "SPINNER" };
  switch (tool) {
    case "A2":
      if (s.lookupOpen) return { pass: false, code: "LOOKUP_OVERLAY" };
      if (
        /folio/i.test(s.activeTab) &&
        /Folio Balance/i.test(s.textSample) &&
        !s.processing &&
        !/Records:\s*0 of 0/i.test(s.textSample)
      )
        return { pass: true, code: "FOLIO_TAB" };
      return { pass: false, code: "NOT_FOLIO" };
    case "A3":
      if (s.hasSentEmail && !s.startCenter)
        return { pass: true, code: "SENT_EMAIL_GRID" };
      return { pass: false, code: "NOT_SENT_EMAIL" };
    case "A5":
      if (s.kpiZero || (s.hasAvailSummary && !s.hasQuote))
        return { pass: false, code: "WRONG_AVAIL_SUMMARY" };
      if (s.hasQuote && s.hasQuoteGrid && !s.login) return { pass: true, code: "QUOTE_GRID" };
      if (s.hasQuote && !s.login) return { pass: false, code: "QUOTE_FORM_EMPTY" };
      return { pass: false, code: "NOT_QUOTE" };
    case "A6":
      if (s.hasGroup && !s.startCenter) return { pass: true, code: "GROUP_BOOKING" };
      return { pass: false, code: "NOT_GROUP" };
    case "A8":
      if (s.hasOrg && !s.startCenter) return { pass: true, code: "ORG_PROFILES" };
      return { pass: false, code: "NOT_ORG" };
    case "A9":
      if (s.lookupOpen) return { pass: false, code: "LOOKUP_OVERLAY" };
      if (/notes|traces/i.test(s.activeTab) && !s.processing)
        return { pass: true, code: "NOTES_OR_TRACES_TAB" };
      return { pass: false, code: "NOT_NOTES_TRACES" };
    default:
      return { pass: false, code: "UNKNOWN_TOOL" };
  }
}

async function runTool(page, tool, confirm) {
  await dismissExt(page);
  if (tool === "A2") {
    await openGuestStay(page, confirm);
    const tab = await clickVisibleTab(page, "Folio");
    process.stdout.write(`HMS_HITL tab=Folio ${JSON.stringify(tab)}\n`);
    await page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && /OSRESV\.FOL/i.test(r.url()),
      { timeout: 20_000 },
    ).catch(() => null);
    await page.waitForTimeout(4_000);
    await waitNoSpinner(page, 25_000);
    await dismissStayLookup(page);
    await holdPainted(page);
    return;
  }
  if (tool === "A9") {
    await openGuestStay(page, confirm);
    await clickVisibleTab(page, "Traces");
    await waitNoSpinner(page, 25_000);
    await dismissStayLookup(page);
    await clickVisibleTab(page, "Notes");
    await waitNoSpinner(page, 25_000);
    await dismissStayLookup(page);
    await page.locator("textarea").first().click({ force: true, timeout: 3000 }).catch(() => undefined);
    await page.keyboard.press("Escape");
    await waitNoSpinner(page, 25_000);
    await holdPainted(page);
    return;
  }
  if (tool === "A3") {
    await menuSearch(page, "Sent Email");
    await waitNoSpinner(page, 20_000);
    let s = await snap(page);
    if (!s.hasSentEmail) {
      await menuPath(page, ["Front Desk", "Sent Email"]);
      await waitNoSpinner(page, 20_000);
      s = await snap(page);
    }
    if (!s.hasSentEmail) {
      await openMore(page);
      await clickText(page, "Administration", { hover: true });
      await page.waitForTimeout(1200);
      await clickText(page, "Sent Email");
      await page.waitForTimeout(8_000);
    }
    await waitNoSpinner(page, 20_000);
    await holdPainted(page);
    return;
  }
  if (tool === "A5") {
    await menuSearch(page, "Room Type and Rate Availability");
    await waitNoSpinner(page, 40_000);
    let s = await snap(page);
    if (!s.hasQuote || s.kpiZero) {
      await page.keyboard.press("Alt+z").catch(() => undefined);
      await page.waitForTimeout(4_000);
    }
    if (!(await snap(page)).hasQuote) {
      await menuPath(page, [
        "Front Desk",
        "Availability",
        "Room Type and Rate Availability",
      ]);
    }
    await waitNoSpinner(page, 40_000);
    await dismissExt(page);
    await fillQuoteSearch(page);
    await dismissExt(page);
    await holdPainted(page);
    return;
  }
  if (tool === "A6") {
    await menuSearch(page, "Group Booking");
    await waitNoSpinner(page, 45_000);
    if (!(await snap(page)).hasGroup) {
      await menuPath(page, ["Group Sales", "Group Booking"]);
    }
    await waitNoSpinner(page, 45_000);
    await clickText(page, "Run");
    await page.waitForTimeout(8_000);
    await waitNoSpinner(page, 45_000);
    await holdPainted(page);
    return;
  }
  if (tool === "A8") {
    await menuSearch(page, "Organization Profiles");
    await waitNoSpinner(page, 45_000);
    if (!(await snap(page)).hasOrg) {
      await menuPath(page, ["Profiles", "Organization Profiles"]);
    }
    await clickText(page, "Run");
    await waitNoSpinner(page, 45_000);
    await holdPainted(page);
  }
}

async function fillQuoteSearch(page) {
  const room = process.env.HMS_HITL_ROOMTYPE || "DLXQN";
  const filled = await page.evaluate((rt) => {
    const Ext = window.Ext;
    const fields = Ext?.ComponentQuery?.query("textfield, combobox, field") ?? [];
    const names = fields.map((x) => String(x.name ?? "")).filter(Boolean).slice(0, 20);
    const f =
      fields.find((x) => String(x.name ?? "") === "roomtypes") ||
      fields.find((x) => /room type/i.test(String(x.fieldLabel ?? "")));
    if (f?.setValue) {
      f.setValue(rt);
      f.fireEvent?.("change", f, rt);
      f.fireEvent?.("blur", f);
      return { ok: true, via: "ext", names };
    }
    const inp = document.querySelector("input[name=roomtypes]");
    if (!inp) return { ok: false, names };
    inp.focus();
    inp.value = rt;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, via: "dom", names };
  }, room);
  process.stdout.write(
    `HMS_HITL quoteFill ok=${filled.ok} via=${filled.via || "none"} names=${(filled.names || []).join(",")}\n`,
  );
  const searchHit = await clickText(page, "Search");
  process.stdout.write(`HMS_HITL quoteSearch hit=${searchHit}\n`);
  await page.waitForResponse(
    (r) => r.request().method() === "POST" && /OSRRAV\.HDR\.search/i.test(r.url()),
    { timeout: 25_000 },
  ).catch(() => process.stdout.write("HMS_HITL no OSRRAV.search xhr\n"));
  await waitNoSpinner(page, 40_000);
  await page.waitForTimeout(3_000);
}

async function trimHitlTail(src, dest) {
  const probe = await execFileP("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    src,
  ]);
  const dur = Number.parseFloat(String(probe.stdout).trim());
  if (!Number.isFinite(dur) || dur <= HITL_TAIL_SEC + 0.5) {
    await copyFile(src, dest);
    return { trimmed: false, duration: dur };
  }
  const start = Math.max(0, dur - HITL_TAIL_SEC);
  const ffmpegTries = [
    ["-y", "-ss", start.toFixed(2), "-i", src, "-t", String(HITL_TAIL_SEC), "-an", "-c:v", "libvpx", "-b:v", "1M", dest],
    ["-y", "-ss", start.toFixed(2), "-i", src, "-t", String(HITL_TAIL_SEC), "-c", "copy", dest],
  ];
  for (const args of ffmpegTries) {
    try {
      await execFileP("ffmpeg", args);
      return { trimmed: true, duration: dur, start };
    } catch {
      /* next */
    }
  }
  await copyFile(src, dest);
  return { trimmed: false, duration: dur, err: "ffmpeg-fail" };
}

async function ensureFfmpeg() {
  const { access } = await import("node:fs/promises");
  const { constants: fsConstants } = await import("node:fs");
  const candidates = [
    process.env.PLAYWRIGHT_FFMPEG_PATH,
    "/home/ubuntu/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux",
    "/opt/nava/playwright-browsers/ffmpeg-1011/ffmpeg-linux",
    "/usr/bin/ffmpeg",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      await access(p, fsConstants.X_OK);
      process.env.PLAYWRIGHT_FFMPEG_PATH = p;
      return;
    } catch {
      /* next */
    }
  }
  throw new Error("FFMPEG_MISSING");
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  await ensureFfmpeg();
  const tool = String(process.env.HMS_HITL_TOOL || "").toUpperCase();
  if (!["A2", "A3", "A5", "A6", "A8", "A9"].includes(tool)) {
    throw new Error("HMS_HITL_TOOL required");
  }
  const outDir =
    process.env.HMS_HITL_OUT ||
    `/tmp/nava-hitl-ui-${tool}.${Date.now().toString(36)}`;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const videoDir = path.join(outDir, "video");
  await mkdir(videoDir, { recursive: true, mode: 0o700 });

  const secret = await loadSecret();
  const confirm = await loadConfirm();
  const origin = new URL(secret.loginUrl).origin;
  process.stdout.write(
    `HMS_HITL start tool=${tool} confirmLen=${confirm.length} out=${outDir}\n`,
  );

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: videoDir, size: { width: 1600, height: 1000 } },
  });
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    const p = new URL(u).pathname.toLowerCase();
    if (
      /(checkin|checkout|newrecord|\/save|\/delete)/i.test(p) &&
      !/\.hdr|\.lst|\.fol|\.trc|\.search/i.test(p)
    ) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  let last = null;
  try {
    await login(page, secret);
    await runTool(page, tool, confirm);
    await dismissStayLookup(page);
    last = await snap(page);
    const shot = path.join(outDir, "last.png");
    await page.screenshot({ path: shot, fullPage: false });
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const { readdir } = await import("node:fs/promises");
  const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
  let videoMeta = { hasVideo: false };
  if (vids[0]) {
    const src = path.join(videoDir, vids[0]);
    const full = path.join(outDir, `${tool}.full.webm`);
    const named = path.join(outDir, `${tool}.webm`);
    await copyFile(src, full);
    const trim = await trimHitlTail(full, named);
    process.stdout.write(
      `HMS_HITL trim trimmed=${trim.trimmed} dur=${trim.duration || 0} start=${trim.start || 0}\n`,
    );
    const buf = await readFile(named);
    videoMeta = {
      hasVideo: true,
      bytes: buf.length,
      sha256: sha256(buf),
      file: named,
      trimmed: Boolean(trim.trimmed),
      fullDuration: trim.duration || null,
    };
  }
  const v = verdictFor(tool, last || {});
  const result = {
    tool,
    verdict: v,
    snap: last,
    video: videoMeta,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(outDir, "hitl-visual.v1.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `HMS_HITL done tool=${tool} pass=${v.pass} code=${v.code} videoBytes=${videoMeta.bytes || 0} sha=${(videoMeta.sha256 || "").slice(0, 16)} out=${outDir}\n`,
  );
  if (!v.pass) process.exitCode = 2;
}

main().catch((e) => {
  process.stderr.write(`HMS_HITL fail ${scrub(e instanceof Error ? e.message : "x")}\n`);
  process.exit(1);
});
