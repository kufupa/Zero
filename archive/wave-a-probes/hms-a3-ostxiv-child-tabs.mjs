/**
 * OSTXIV child tabs after HDR (view/open, not print/generate).
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
    process.env.HMS_A3_CHILD_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a3-payload/ostxiv-child-tabs.v1.json";
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(new URL(u).pathname))
      return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(secret.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("input[name=userid], input[name=username], input[name=j_username]").first().fill(secret.username);
  await page.locator("input[name=password]").fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole("button", { name: "Sign in" }).click().catch(async () => {
      await page.locator("input[name=password]").press("Enter");
    }),
  ]);
  await page.waitForTimeout(4_000);
  const out = await page.evaluate(async () => {
    const scrubLocal = (s) =>
      String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]").replace(/\b\d{7,}\b/g, "[n]");
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
      return { status: r.status, text: await r.text() };
    };
    for (const path of ["/web/base/BSSTRT.HDR", "/web/base/BSSTRT"]) {
      await post(path, { SYSTEM_FUNCTION_NAME: "BSSTRT", USER_FUNCTION_NAME: "BSSTRT", manurefresh: "yes" }).catch(() => undefined);
    }
    await post("/web/base/OSTXIV?FUNCTION_CLASS=WEBL", {
      SYSTEM_FUNCTION_NAME: "OSTXIV",
      USER_FUNCTION_NAME: "OSTXIV",
      FUNCTION_CLASS: "WEBL",
      CURRENT_TAB_NAME: "",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
    });
    const hdr = await post("/web/base/OSTXIV.HDR", {
      SYSTEM_FUNCTION_NAME: "OSTXIV",
      USER_FUNCTION_NAME: "OSTXIV",
      CURRENT_TAB_NAME: "HDR",
    });
    const t = hdr.text;
    const osTabs = [...new Set([...t.matchAll(/OSTXIV[._][A-Z]{2,8}/gi)].map((x) => x[0].toUpperCase()))];
    const vis = {};
    for (const k of ["preview", "view", "open", "document", "attachment", "retrievable", "pdf"]) {
      vis[k] = t.toLowerCase().includes(k);
    }
    const labels = [
      ...new Set(
        [...t.matchAll(/"(?:label|text|title)"\s*:\s*"([^"]{2,50})"/gi)]
          .map((x) => x[1])
          .filter((s) => /view|open|preview|print|document|attach|pdf|detail/i.test(s)),
      ),
    ].slice(0, 30);
    const probes = {};
    const tabs = ["DET", "DTL", "VW", "VIEW", "PRE", "PRV", "ATT", "DOC", "PDF", "INV", "LIN", "ITM"];
    const base = {
      SYSTEM_FUNCTION_NAME: "OSTXIV",
      USER_FUNCTION_NAME: "OSTXIV",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
    };
    for (const tab of tabs) {
      const r = await post(`/web/base/OSTXIV.${tab}`, { ...base, CURRENT_TAB_NAME: tab });
      probes[`OSTXIV.${tab}`] = {
        status: r.status,
        bytes: r.text.length,
        classPath: /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null,
        msg: (() => {
          const m = /"msg"\s*:\s*"([^"]{0,120})"/.exec(r.text);
          return m ? scrubLocal(m[1]) : null;
        })(),
      };
    }
    return { hdrBytes: t.length, osTabs, vis, labels, probes };
  });
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(out) + "\n");
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
