/**
 * Menu-only Guest Stay → click Run → DOM+Ext dblclick → Rate Details.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { hmsSecretSchema } from "../dist/hms/runtime.js";

function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
    .replace(/\b\d{7,}\b/g, "[n]");
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  const arn = process.env.HMS_READ_SECRET_ARN;
  const outPath =
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/gs-run-dblclick-rate.v1.json";
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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(new URL(u).pathname))
      return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const xhr = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? "");
    xhr.push({
      path: m[1].toUpperCase(),
      tab: params.get("CURRENT_TAB_NAME"),
      user: params.get("USER_FUNCTION_NAME"),
      cls: params.get("FUNCTION_CLASS"),
    });
  });
  await page.goto(secret.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("input[name=userid], input[name=username], input[name=j_username]").first().fill(secret.username);
  await page.locator("input[name=password]").fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole("button", { name: "Sign in" }).click().catch(async () => {
      await page.locator("input[name=password]").press("Enter");
    }),
  ]);
  await page.waitForTimeout(8_000);
  await page.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find((n) => (n.textContent || "").trim() === "More");
    if (more) more.click();
  });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find((n) => (n.textContent || "").trim() === "Front Desk");
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page.waitForTimeout(1_800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find((n) => (n.textContent || "").trim() === "Guest Stay");
    if (el) el.click();
  });
  await page.waitForTimeout(8_000);

  const run = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-btn-inner, button, span")].find((n) => (n.textContent || "").trim() === "Run");
    if (!el) return false;
    el.click();
    return true;
  });
  await page.waitForTimeout(10_000);

  const state = await page.evaluate(() => {
    const Ext = window.Ext;
    const gs = Ext?.ComponentQuery?.query("grid") ?? [];
    return {
      domRows: document.querySelectorAll(".x-grid-row, .x-grid3-row, .x-grid-item").length,
      grids: gs.map((g) => ({
        storeId: String(g.store?.storeId ?? "").slice(0, 60),
        title: String(g.title ?? ""),
        count: g.store?.getCount?.() ?? 0,
      })),
    };
  });

  const mark = xhr.length;
  const opened = await page.evaluate(() => {
    const Ext = window.Ext;
    const gs = Ext?.ComponentQuery?.query("grid") ?? [];
    const grid = gs.find((g) => (g.store?.getCount?.() ?? 0) > 0) ?? null;
    let ext = { ok: false };
    if (grid) {
      const rec = grid.store.getAt(0);
      try {
        grid.getSelectionModel?.().select(rec);
        grid.fireEvent("itemdblclick", grid, rec);
        ext = { ok: true, count: grid.store.getCount(), storeId: String(grid.store.storeId ?? "") };
      } catch (e) {
        ext = { ok: false, err: String(e).slice(0, 80) };
      }
    }
    const rows = [...document.querySelectorAll(".x-grid-row, .x-grid3-row, .x-grid-item")];
    if (rows[0]) {
      rows[0].click();
      rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
    return { ext, domN: rows.length };
  });
  await page.waitForTimeout(8_000);
  const xhrOpen = xhr.slice(mark);

  const markR = xhr.length;
  const rate = await page.evaluate(() => {
    const Ext = window.Ext;
    const hits = [];
    for (const c of Ext?.ComponentQuery?.query("button") ?? []) {
      if (!/rate.?detail/i.test(String(c.text ?? c.tooltip ?? ""))) continue;
      hits.push(String(c.text ?? "").slice(0, 40));
      try {
        if (typeof c.handler === "function") c.handler();
        else if (c.handler?.fn) c.handler.fn.call(c.handler.scope || c);
        c.fireEvent?.("click", c);
      } catch (e) {
        hits.push("err:" + String(e).slice(0, 60));
      }
    }
    return hits;
  });
  await page.waitForTimeout(6_000);

  const out = { run, state, opened, xhrOpen, rate, xhrRate: xhr.slice(markR), xhrAll: xhr };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(out) + "\n");
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
