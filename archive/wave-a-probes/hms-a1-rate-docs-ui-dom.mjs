/**
 * Dedicated Ext UI: More→Front Desk→Guest Stay, DOM grid dblclick, harvest
 * Rate Details + Documents tab XHR. No long fetch probes first (session dies).
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  const outPath =
    process.env.HMS_A1_UI2_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-docs-ui-dom.v1.json";
  const raw = JSON.parse(await readFile(candPath, "utf8"));
  const exact = raw.value;
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
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
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
  await page.waitForTimeout(5_000);

  await page.evaluate(async () => {
    for (const path of ["/web/base/BSSTRT.HDR", "/web/base/BSSTRT"]) {
      await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: "BSSTRT",
          USER_FUNCTION_NAME: "BSSTRT",
          manurefresh: "yes",
        }).toString(),
      }).catch(() => undefined);
    }
    await fetch("/web/base/OSRESS?FUNCTION_CLASS=WEBL", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: "OSRESS",
        USER_FUNCTION_NAME: "OSRESS",
        FUNCTION_CLASS: "WEBL",
        CURRENT_TAB_NAME: "",
        MENU_MODULE_KEY: "0",
        removescreenflows: "yes",
      }).toString(),
    });
  });
  await page.waitForTimeout(1_500);

  const trace = [];
  await page.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  trace.push("more");
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
  trace.push("frontDesk");
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Guest Stay",
    );
    if (el) el.click();
  });
  trace.push("guestStay");
  await page.waitForTimeout(6_000);

  const chrome0 = await page.evaluate(() => ({
    url: location.pathname,
    title: document.title.slice(0, 80),
    texts: [
      ...new Set(
        [...document.querySelectorAll(".x-tab-inner, .x-btn-inner, a, span")]
          .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 1 && t.length < 40),
      ),
    ].slice(0, 50),
    gridRows: document.querySelectorAll(
      ".x-grid-row, .x-grid3-row, .x-grid-item",
    ).length,
    imgs: document.querySelectorAll("img").length,
  }));
  trace.push(`chrome0:${chrome0.url}:rows=${chrome0.gridRows}:imgs=${chrome0.imgs}`);

  // Fill confirmation if search box exists
  await page.evaluate((conf) => {
    const inputs = [...document.querySelectorAll("input")];
    const search =
      inputs.find((i) =>
        /confirm|search|filter/i.test((i.name || "") + (i.id || "") + (i.placeholder || "")),
      ) || inputs.find((i) => i.offsetParent !== null);
    if (!search) return;
    search.focus();
    search.value = conf;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
  }, exact);
  const run = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "Run",
    );
    if (!el) return false;
    el.click();
    return true;
  });
  trace.push(`run:${run}`);
  await page.waitForTimeout(8_000);

  const rowClick = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        ".x-grid-row, .x-grid3-row, tr.x-grid-row, .x-grid-item",
      ),
    ];
    if (rows[0]) {
      rows[0].click();
      rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return { ok: true, n: rows.length };
    }
    return { ok: false, n: rows.length };
  });
  trace.push(`row:${rowClick.ok}:${rowClick.n}`);
  await page.waitForTimeout(6_000);

  const afterOpen = await page.evaluate(() => ({
    texts: [
      ...new Set(
        [
          ...document.querySelectorAll(
            ".x-tab-inner, .x-btn-inner, .x-menu-item-text, a.x-tab",
          ),
        ]
          .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 1 && t.length < 48),
      ),
    ].slice(0, 80),
    imgs: [...document.querySelectorAll("img")]
      .map((i) => ({
        src: (i.getAttribute("src") || "").slice(-70),
        title: i.getAttribute("title") || i.getAttribute("data-qtip") || "",
      }))
      .filter((x) => /rate|toolbar|document|detail|confidential/i.test(x.src + x.title))
      .slice(0, 40),
    imgCount: document.querySelectorAll("img").length,
  }));

  const mark = xhr.length;
  const rateClick = await page.evaluate(() => {
    const hits = [];
    for (const img of document.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      const title = img.getAttribute("title") || img.getAttribute("data-qtip") || "";
      if (/rate-details|rate\s*detail|confidential-rate/i.test(src + title)) {
        hits.push((src || title).slice(-60));
        img.click();
        img.closest("a,button,div,span")?.click();
      }
    }
    const el = [...document.querySelectorAll(".x-btn-inner, span, a")].find((n) =>
      /rate\s*details?/i.test((n.textContent || "").trim()),
    );
    if (el) {
      hits.push("text:" + el.textContent.trim().slice(0, 40));
      el.click();
    }
    return hits;
  });
  await page.waitForTimeout(4_000);
  const docClick = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-tab-inner, .x-btn-inner, span, a")].find(
      (n) => /^documents?$/i.test((n.textContent || "").trim()),
    );
    if (!el) return false;
    el.click();
    return true;
  });
  await page.waitForTimeout(4_000);

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    trace,
    chrome0,
    rowClick,
    afterOpen,
    rateClick,
    docClick,
    xhrAfter: xhr.slice(mark),
    xhrAll: xhr.slice(-40),
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      trace,
      chrome0,
      rowClick,
      texts: afterOpen.texts,
      imgs: afterOpen.imgs,
      imgCount: afterOpen.imgCount,
      rateClick,
      docClick,
      xhrAfter: out.xhrAfter,
      xhrTail: xhr.slice(-15),
    }) + "\n",
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
