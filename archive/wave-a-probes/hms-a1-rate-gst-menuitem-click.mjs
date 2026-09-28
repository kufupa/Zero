/**
 * Click Ext menuitem action=rate_gst / rate_lse after Guest Stay Run.
 * Capture XHR + any dialog msg. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-gst-menuitem-click.v1.json";
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
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? "");
    xhr.push({
      path: m[1].toUpperCase(),
      tab: params.get("CURRENT_TAB_NAME"),
      user: params.get("USER_FUNCTION_NAME"),
      cls: params.get("FUNCTION_CLASS"),
      sys: params.get("SYSTEM_FUNCTION_NAME"),
    });
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
  await page.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Front Desk",
    );
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page.waitForTimeout(1_800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Guest Stay",
    );
    if (el) el.click();
  });
  await page.waitForTimeout(8_000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "Run",
    );
    if (el) el.click();
  });
  await page.waitForTimeout(10_000);

  // Select first grid row so action has record context
  await page.evaluate(() => {
    const Ext = window.Ext;
    const gs = Ext?.ComponentQuery?.query("grid") ?? [];
    const grid = gs.find((g) => (g.store?.getCount?.() ?? 0) > 0);
    if (!grid) return;
    const rec = grid.store.getAt(0);
    grid.getSelectionModel?.().select(rec);
    try {
      grid.fireEvent("itemdblclick", grid, rec);
    } catch {
      /* ignore */
    }
  });
  await page.waitForTimeout(5_000);

  const mark = xhr.length;
  const click = await page.evaluate(() => {
    const Ext = window.Ext;
    const items = Ext?.ComponentQuery?.query("menuitem") ?? [];
    const hits = [];
    for (const want of ["rate_gst", "rate_lse"]) {
      const mi = items.find((i) => String(i.action ?? "") === want);
      if (!mi) {
        hits.push({ want, found: false });
        continue;
      }
      hits.push({
        want,
        found: true,
        text: String(mi.text ?? "").slice(0, 40),
        hidden: Boolean(mi.hidden),
        disabled: Boolean(mi.disabled),
      });
      try {
        // Show parent menu if needed
        const menu = mi.up?.("menu");
        menu?.show?.();
        mi.show?.();
        mi.enable?.();
        if (typeof mi.handler === "function") mi.handler(mi);
        else if (mi.handler?.fn) mi.handler.fn.call(mi.handler.scope || mi, mi);
        mi.fireEvent?.("click", mi);
        mi.el?.dom?.click();
      } catch (e) {
        hits.push({ want, err: String(e).slice(0, 120) });
      }
    }
    // Also try parent ratedetailsmenu button show + click
    for (const b of Ext?.ComponentQuery?.query("button") ?? []) {
      if (!/button_ratedetails/i.test(String(b.iconCls || b.icon || ""))) continue;
      try {
        b.show?.();
        b.setVisible?.(true);
        b.enable?.();
        if (b.menu) {
          b.showMenu?.();
          b.menu.show?.();
        }
        b.fireEvent?.("click", b);
        b.el?.dom?.click();
        hits.push({ button: "ratedetails", shown: true });
      } catch (e) {
        hits.push({ button: "ratedetails", err: String(e).slice(0, 80) });
      }
    }
    const dialogs = [
      ...document.querySelectorAll(".x-window, .x-message-box, .x-msg-box"),
    ]
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200))
      .filter(Boolean)
      .slice(0, 5);
    return { hits, dialogs };
  });
  await page.waitForTimeout(6_000);

  const out = {
    click,
    xhrAfter: xhr.slice(mark),
    xhrAll: xhr.slice(-40),
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
