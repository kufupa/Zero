/**
 * Menu-only Guest Stay → Ext setActiveTab Documents/Tax/Guest Details + Rate Details button.
 * Dump tab itemIds. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_EXT_TABS_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/gs-ext-setactivetab.v1.json";
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
      tabpk: params.get("CURRENT_TABPK"),
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
  await page.waitForTimeout(10_000);

  const tabMeta = await page.evaluate(() => {
    const w = window;
    const Ext = w.Ext;
    const panels = Ext?.ComponentQuery?.query("tabpanel") ?? [];
    const tabs = [];
    for (const p of panels) {
      const items = p.items?.items ?? p.items ?? [];
      const arr = Array.isArray(items) ? items : [];
      for (const it of arr) {
        tabs.push({
          title: String(it.title ?? it.tooltip ?? "").slice(0, 60),
          itemId: String(it.itemId ?? "").slice(0, 40),
          id: String(it.id ?? "").slice(0, 50),
          xtype: String(it.xtype ?? it.getXType?.() ?? "").slice(0, 40),
          card: String(it.cardId ?? it.functionName ?? it.tabName ?? "").slice(0, 40),
        });
      }
    }
    const imgs = [...document.querySelectorAll("img")].map((i) => ({
      src: (i.getAttribute("src") || "").slice(-90),
      title: (i.getAttribute("title") || i.getAttribute("data-qtip") || i.getAttribute("alt") || "").slice(0, 50),
    })).slice(0, 80);
    const btns = (Ext?.ComponentQuery?.query("button") ?? []).map((b) => ({
      text: String(b.text ?? b.tooltip ?? b.qtip ?? "").slice(0, 50),
      icon: String(b.icon ?? b.iconCls ?? "").slice(0, 60),
      itemId: String(b.itemId ?? "").slice(0, 40),
    })).filter((b) => /rate|detail|document|print|folio|trace/i.test(b.text + b.icon + b.itemId)).slice(0, 40);
    return { panelN: panels.length, tabs: tabs.slice(0, 80), imgs, btns };
  });

  const activate = async (title) => {
    const mark = xhr.length;
    const result = await page.evaluate((lab) => {
      const Ext = window.Ext;
      const panels = Ext?.ComponentQuery?.query("tabpanel") ?? [];
      for (const p of panels) {
        const items = p.items?.items ?? [];
        const item = items.find((i) => String(i.title ?? "") === lab);
        if (!item) continue;
        try {
          p.setActiveTab(item);
          return {
            ok: true,
            active: p.getActiveTab?.()?.title ?? null,
            itemId: String(item.itemId ?? ""),
            id: String(item.id ?? ""),
          };
        } catch (e) {
          return { ok: false, err: String(e).slice(0, 120) };
        }
      }
      return { ok: false, err: "notfound" };
    }, title);
    await page.waitForTimeout(5_000);
    return { title, result, xhr: xhr.slice(mark) };
  };

  const gst = await activate("Guest Details");
  const docs = await activate("Documents");
  const tax = await activate("Tax Invoicing");
  const trc = await activate("Traces");
  const fol = await activate("Folio");

  const markRate = xhr.length;
  const rate = await page.evaluate(() => {
    const Ext = window.Ext;
    const hits = [];
    const comps = [
      ...(Ext?.ComponentQuery?.query("button") ?? []),
      ...(Ext?.ComponentQuery?.query("tool") ?? []),
      ...(Ext?.ComponentQuery?.query("[tooltip]") ?? []),
    ];
    for (const c of comps) {
      const blob = [c.tooltip, c.qtip, c.text, c.icon, c.iconCls, c.itemId, c.ariaLabel].map((x) => String(x ?? "")).join(" ");
      if (/rate.?detail/i.test(blob)) {
        hits.push({ blob: blob.slice(0, 80), itemId: String(c.itemId ?? "") });
        try {
          c.fireEvent?.("click");
          c.handler?.();
          c.el?.dom?.click();
        } catch {
          /* ignore */
        }
      }
    }
    for (const img of document.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      if (/rate-details/i.test(src)) {
        hits.push({ blob: src.slice(-60), itemId: "img" });
        img.click();
      }
    }
    return hits;
  });
  await page.waitForTimeout(5_000);

  const out = {
    tabMeta,
    gst,
    docs,
    tax,
    trc,
    fol,
    rate,
    xhrRate: xhr.slice(markRate),
    xhrAll: xhr,
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      panelN: tabMeta.panelN,
      tabs: tabMeta.tabs,
      imgs: tabMeta.imgs,
      btns: tabMeta.btns,
      gst,
      docs,
      tax,
      trc,
      fol,
      rate,
      xhrRate: out.xhrRate,
      xhrTail: xhr.slice(-20),
    }) + "\n",
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
