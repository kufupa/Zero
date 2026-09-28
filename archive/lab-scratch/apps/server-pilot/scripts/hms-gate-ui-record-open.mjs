/**
 * After Guest Stay Run: Playwright dblclick row → wait HDR → Rate Details + Documents.
 * Falsify "list-select only" mistake. No PII printed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { hmsSecretSchema } from "../../../../../apps/server-pilot/dist/hms/runtime.js";

function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
    .replace(/\b\d{7,}\b/g, "[n]");
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  const arn = process.env.HMS_READ_SECRET_ARN;
  const outPath =
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/gate-reverify/ui-record-open.v1.json";
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "af-south-1",
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(
        new URL(u).pathname,
      )
    )
      return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const xhr = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.?_=]{2,60})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? "");
    xhr.push({
      path: m[1].split("?")[0].toUpperCase(),
      user: params.get("USER_FUNCTION_NAME"),
      cls: params.get("FUNCTION_CLASS"),
      tab: params.get("CURRENT_TAB_NAME"),
    });
  });
  page.on("response", async (resp) => {
    if (resp.request().method() !== "POST") return;
    if (!resp.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(resp.url());
    if (!m) return;
    const path = m[1].toUpperCase();
    if (!/RATE|DOC|GST|HDR|OSRASD|POPU/i.test(path + (resp.request().postData() ?? "")))
      return;
    try {
      const text = await resp.text();
      const msg = /"msg"\s*:\s*"([^"]{0,160})"/.exec(text)?.[1];
      xhr.push({
        kind: "resp",
        path,
        status: resp.status(),
        bytes: text.length,
        msg: msg ? scrub(msg) : null,
      });
    } catch {
      /* ignore */
    }
  });

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

  // Menu-only Guest Stay
  await page.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  await page.waitForTimeout(1_000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Front Desk",
    );
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Guest Stay",
    );
    if (el) el.click();
  });
  await page.waitForTimeout(10_000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "Run",
    );
    if (el) el.click();
  });
  await page.waitForTimeout(12_000);

  const markBeforeOpen = xhr.length;
  // Playwright dblclick first data row
  const row = page.locator(".x-grid-row, .x-grid3-row, tr.x-grid-row").first();
  let dbl = "none";
  try {
    await row.dblclick({ force: true, timeout: 8_000 });
    dbl = "playwright_row";
  } catch {
    await page.evaluate(() => {
      const Ext = window.Ext;
      const gs = Ext?.ComponentQuery?.query("grid") ?? [];
      const grid = gs.find((g) => (g.store?.getCount?.() ?? 0) > 0);
      if (!grid) return;
      const view = grid.getView?.();
      const node = view?.getNode?.(0);
      if (node) {
        node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }
    });
    dbl = "ext_node";
  }
  await page.waitForTimeout(8_000);

  const afterOpen = xhr.slice(markBeforeOpen);
  const hdrOpened = afterOpen.some(
    (x) => x.path === "OSRESV.HDR" || (x.path === "OSRESV" && x.tab === "HDR"),
  );

  const markRate = xhr.length;
  const rateClick = await page.evaluate(() => {
    const Ext = window.Ext;
    const out = { steps: [] };
    // Prefer visible Rate Details button
    for (const b of Ext?.ComponentQuery?.query("button") ?? []) {
      const txt = String(b.text || b.getText?.() || "").trim();
      const icon = String(b.iconCls || b.icon || "");
      if (!/rate detail/i.test(txt) && !/button_ratedetails|ratedetails/i.test(icon))
        continue;
      try {
        b.show?.();
        b.setVisible?.(true);
        b.enable?.();
        if (b.menu) {
          b.showMenu?.();
          out.steps.push("button_showMenu");
        }
        b.el?.dom?.click();
        b.fireEvent?.("click", b);
        out.steps.push(`button_click:${txt || icon}`);
      } catch (e) {
        out.steps.push(`button_err:${String(e).slice(0, 80)}`);
      }
    }
    for (const mi of Ext?.ComponentQuery?.query("menuitem") ?? []) {
      if (String(mi.action ?? "") !== "rate_gst") continue;
      try {
        mi.up?.("menu")?.show?.();
        mi.show?.();
        mi.enable?.();
        if (typeof mi.handler === "function") mi.handler(mi);
        else if (mi.handler?.fn) mi.handler.fn.call(mi.handler.scope || mi, mi);
        mi.fireEvent?.("click", mi);
        mi.el?.dom?.click();
        out.steps.push("menuitem_rate_gst");
      } catch (e) {
        out.steps.push(`mi_err:${String(e).slice(0, 80)}`);
      }
    }
    // Documents tab
    for (const t of Ext?.ComponentQuery?.query("tab") ?? []) {
      const id = String(t.itemId || t.id || "");
      const title = String(t.title || t.text || "");
      if (id !== "DOC" && !/document/i.test(title)) continue;
      try {
        t.show?.();
        t.enable?.();
        const tp = t.up?.("tabpanel");
        tp?.setActiveTab?.(t);
        t.el?.dom?.click();
        out.steps.push(`doc_tab:${id || title}`);
      } catch (e) {
        out.steps.push(`doc_err:${String(e).slice(0, 80)}`);
      }
    }
    const dialogs = [...document.querySelectorAll(".x-window, .x-message-box")]
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200))
      .filter((t) => /security|rights|rate|document|error|permission|insufficient/i.test(t))
      .slice(0, 6);
    out.dialogs = dialogs;
    return out;
  });
  await page.waitForTimeout(8_000);

  // Group Sales menu harvest (hover carefully)
  await page.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Group Sales",
    );
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    }
  });
  await page.waitForTimeout(2_000);
  const groupSalesMenu = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll(".x-menu-item-text, .x-menu-item")]
          .map((n) => (n.textContent || "").trim())
          .filter(Boolean),
      ),
    ].slice(0, 40),
  );

  const out = {
    capturedAt: new Date().toISOString(),
    dbl,
    hdrOpened,
    afterOpen: afterOpen.slice(0, 40),
    rateClick,
    xhrAfterRateDoc: xhr.slice(markRate),
    groupSalesMenu,
    eventsPresent: groupSalesMenu.some((t) => /event/i.test(t)),
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(out) + "\n");
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
