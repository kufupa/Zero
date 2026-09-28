/**
 * Menu-only Guest Stay (no prior OSRESS fetch — that kicked logindisp).
 * Capture XHR + tab/toolbar. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_UI3_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/guest-stay-menu-only.v1.json";
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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(new URL(u).pathname))
      return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const xhr = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    xhr.push({
      method: req.method(),
      path: m ? m[1].toUpperCase() : new URL(req.url()).pathname.slice(0, 60),
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
  const afterLogin = await page.evaluate(() => ({
    url: location.pathname,
    texts: [...new Set([...document.querySelectorAll("a,span,button")].map((n) => (n.textContent || "").trim()).filter((t) => t.length > 1 && t.length < 32))].slice(0, 40),
  }));
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
  const menuItems = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll(".x-menu-item-text")].map((n) => (n.textContent || "").trim()).filter(Boolean))].slice(0, 40),
  );
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find((n) => (n.textContent || "").trim() === "Guest Stay");
    if (el) el.click();
  });
  await page.waitForTimeout(10_000);
  const afterGs = await page.evaluate(() => ({
    url: location.pathname,
    title: document.title.slice(0, 80),
    gridRows: document.querySelectorAll(".x-grid-row, .x-grid3-row, .x-grid-item").length,
    imgs: document.querySelectorAll("img").length,
    texts: [...new Set([...document.querySelectorAll(".x-tab-inner, .x-btn-inner")].map((n) => (n.textContent || "").trim()).filter((t) => t.length > 1 && t.length < 40))].slice(0, 40),
  }));
  const paths = [...new Set(xhr.map((x) => x.method + ":" + x.path))].slice(0, 60);
  const out = { afterLogin, menuItems, afterGs, paths };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(out) + "\n");
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
