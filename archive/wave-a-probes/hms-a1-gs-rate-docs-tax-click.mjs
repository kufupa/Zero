/**
 * Menu-only Guest Stay (keeps COMMON). Dblclick row → Rate Details + Documents + Tax Invoicing.
 * Harvest XHR. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_UI4_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/gs-rate-docs-tax-click.v1.json";
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
      sys: params.get("SYSTEM_FUNCTION_NAME"),
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
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find((n) => (n.textContent || "").trim() === "Front Desk");
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page.waitForTimeout(2_000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find((n) => (n.textContent || "").trim() === "Guest Stay");
    if (el) el.click();
  });
  await page.waitForTimeout(10_000);

  const snap = async (tag) =>
    page.evaluate((t) => {
      const tabs = [
        ...new Set(
          [...document.querySelectorAll(".x-tab-inner")]
            .map((n) => (n.textContent || "").trim())
            .filter((x) => x.length > 1 && x.length < 48),
        ),
      ];
      const imgs = [...document.querySelectorAll("img")]
        .map((i) => ({
          src: (i.getAttribute("src") || "").slice(-70),
          title: i.getAttribute("title") || i.getAttribute("data-qtip") || i.getAttribute("alt") || "",
        }))
        .filter((x) => /rate|detail|document|toolbar|confidential/i.test(x.src + x.title))
        .slice(0, 40);
      return {
        tag: t,
        url: location.pathname,
        tabs,
        imgs,
        imgCount: document.querySelectorAll("img").length,
        rows: document.querySelectorAll(".x-grid-row, .x-grid3-row, .x-grid-item").length,
      };
    }, tag);

  const before = await snap("afterMenu");
  const mark0 = xhr.length;

  const rowClick = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".x-grid-row, .x-grid3-row, tr.x-grid-row, .x-grid-item")];
    if (!rows[0]) return { ok: false, n: 0 };
    rows[0].click();
    rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return { ok: true, n: rows.length };
  });
  await page.waitForTimeout(7_000);
  const afterRow = await snap("afterRow");
  const xhrRow = xhr.slice(mark0);

  const clickLabel = async (label) =>
    page.evaluate((lab) => {
      const el = [...document.querySelectorAll(".x-tab-inner, .x-btn-inner, span, a")].find(
        (n) => (n.textContent || "").trim() === lab,
      );
      if (!el) return false;
      el.click();
      return true;
    }, label);

  const markDocs = xhr.length;
  const docsClick = await clickLabel("Documents");
  await page.waitForTimeout(5_000);
  const afterDocs = await snap("afterDocs");
  const xhrDocs = xhr.slice(markDocs);

  const markTax = xhr.length;
  const taxClick = await clickLabel("Tax Invoicing");
  await page.waitForTimeout(5_000);
  const afterTax = await snap("afterTax");
  const xhrTax = xhr.slice(markTax);

  const markRate = xhr.length;
  const rateClick = await page.evaluate(() => {
    const hits = [];
    for (const img of document.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      const title = img.getAttribute("title") || img.getAttribute("data-qtip") || img.getAttribute("alt") || "";
      if (/rate-details|rate\s*detail/i.test(src + title)) {
        hits.push({ how: "img", src: src.slice(-60), title: title.slice(0, 40) });
        img.click();
        img.closest("a,button,div,span")?.click();
      }
    }
    const el = [...document.querySelectorAll(".x-btn-inner, span, a, .x-menu-item-text")].find((n) =>
      /rate\s*details?/i.test((n.textContent || "").trim()),
    );
    if (el) {
      hits.push({ how: "text", title: el.textContent.trim().slice(0, 40) });
      el.click();
    }
    return hits;
  });
  await page.waitForTimeout(6_000);
  const afterRate = await snap("afterRate");
  const xhrRate = xhr.slice(markRate);

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    rowClick,
    docsClick,
    taxClick,
    rateClick,
    snaps: { before, afterRow, afterDocs, afterTax, afterRate },
    xhrRow,
    xhrDocs,
    xhrTax,
    xhrRate,
    xhrAll: xhr.slice(-80),
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      rowClick,
      docsClick,
      taxClick,
      rateClick,
      tabs: afterRow.tabs,
      imgs: afterRow.imgs,
      xhrRow,
      xhrDocs,
      xhrTax,
      xhrRate,
    }) + "\n",
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
