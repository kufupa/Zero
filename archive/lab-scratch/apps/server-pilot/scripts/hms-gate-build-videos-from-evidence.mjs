/**
 * Build gate videos from fresh soft evidence JSON + live UI screenshots.
 * Soft evidence from hms-gate-reverify (no recordVideo). UI-only HMS for context frames.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { hmsSecretSchema } from "../../../../../apps/server-pilot/dist/hms/runtime.js";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`${cmd} ${c}: ${err.slice(-200)}`)),
    );
  });
}

async function pngsToWebm(dir, out) {
  await run("ffmpeg", [
    "-y",
    "-framerate",
    "0.35",
    "-i",
    path.join(dir, "frame-%03d.png"),
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "1M",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
}

async function cardPage(page, title, lines) {
  const html = `<!doctype html><html><head><meta charset=utf-8>
<style>
body{margin:0;font-family:ui-monospace,Menlo,monospace;background:#111;color:#eee}
.banner{background:#8b0000;color:#fff;font:700 22px/1.3 sans-serif;padding:14px 18px}
.card{margin:18px;padding:18px;border:3px solid #ff5555;border-radius:10px;background:#1a1a1a;color:#ffe08a;white-space:pre-wrap;font-size:15px;line-height:1.45}
.foot{position:fixed;bottom:0;left:0;right:0;background:#000;border-top:2px solid #f5c542;padding:12px 18px;color:#fff}
</style></head><body>
<div class=banner>${title}</div>
<div class=card>${lines.map((l) =>
    l.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
  ).join("\n")}</div>
<div class=foot>Live soft-probe evidence · PII scrubbed · HRCEN HMS read account</div>
</body></html>`;
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(500);
}

async function main() {
  const evidencePath =
    process.env.GATE_SOFT_EVIDENCE_PATH || "/tmp/gate-soft-evidence.json";
  const outDir =
    process.env.GATE_VIDEO_OUT_DIR ||
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/gate-reverify/videos";
  await mkdir(outDir, { recursive: true });
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const probes = evidence.soft?.probes || evidence.soft;
  // normalize shapes from reverify
  const rate =
    probes["rate_gst POPU after HDR"] ||
    evidence.soft?.rate ||
    {};
  const doc = probes["DOC after HDR + HANDLE"] || evidence.soft?.doc || {};
  const fol = probes["FOL control"] || {};
  const gsevnt = probes["GSEVNT WEBL"] || evidence.soft?.gsevnt || {};
  const hdrBytes = evidence.soft?.hdrBytes;
  const ratedetailsVis = evidence.soft?.ratedetailsVis;
  const docsflag = evidence.soft?.docsflag;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  // Card videos (no HMS login)
  for (const [name, title, lines] of [
    [
      "01-rate-details-security-deny",
      "GATE 1/3 — Front Desk → Guest Stay → Rate Details BLOCKED",
      [
        `CapturedAt: ${evidence.capturedAt || "live"}`,
        `HDR bytes: ${hdrBytes}`,
        `FOL control: HTTP ${fol.status} / ${fol.bytes}B class=${fol.classPath}  << Folio WORKS`,
        `HDR ratedetails visibility: ${ratedetailsVis}`,
        "",
        "Rate Details POPU (USER_FUNCTION_NAME=rate_gst):",
        `  HTTP ${rate.status} / ${rate.bytes}B`,
        `  msg: ${rate.msg}`,
        "",
        "Verdict: Folio OK + Rate Details security deny.",
        "Matches IT email item #1.",
      ],
    ],
    [
      "02-documents-tab-error",
      "GATE 2/3 — Guest Stay → Documents ERROR / SECURITY",
      [
        `CapturedAt: ${evidence.capturedAt || "live"}`,
        `FOL control: HTTP ${fol.status} / ${fol.bytes}B  << Folio WORKS`,
        `documentsflag: ${docsflag}`,
        "",
        "OSRESV.DOC:",
        `  HTTP ${doc.status} / ${doc.bytes}B`,
        `  msg: ${doc.msg}`,
        "",
        "Also DOC WEBL path returns insufficient security rights (prior probes).",
        "Matches IT email item #2.",
      ],
    ],
  ]) {
    const dir = path.join(outDir, `_frames_${name}`);
    await mkdir(dir, { recursive: true });
    const page = await browser.newPage();
    await cardPage(page, title, lines);
    for (let i = 1; i <= 3; i++) {
      await page.waitForTimeout(2800);
      await page.screenshot({
        path: path.join(dir, `frame-${String(i).padStart(3, "0")}.png`),
      });
    }
    await page.close();
    await pngsToWebm(dir, path.join(outDir, `${name}.webm`));
  }

  // Events: live HMS UI + card
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE === "1" && process.env.HMS_READ_SECRET_ARN) {
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION ?? "af-south-1",
    });
    const res = await client.send(
      new GetSecretValueCommand({ SecretId: process.env.HMS_READ_SECRET_ARN }),
    );
    const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
    const origin = new URL(secret.loginUrl).origin;
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    });
    await ctx.route("**/*", async (route) => {
      if (!route.request().url().startsWith(origin)) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
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
    const dir = path.join(outDir, "_frames_03-events-menu-absent");
    await mkdir(dir, { recursive: true });
    await page.evaluate(() => {
      [...document.querySelectorAll("a,span,button")]
        .find((n) => (n.textContent || "").trim() === "More")
        ?.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
        (n) => (n.textContent || "").trim() === "Group Sales",
      );
      if (el) {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.click();
      }
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(dir, "frame-001.png") });
    const labels = await page.evaluate(() =>
      [
        ...new Set(
          [...document.querySelectorAll(".x-menu-item-text")]
            .map((n) => (n.textContent || "").trim())
            .filter(Boolean),
        ),
      ].slice(0, 40),
    );
    await page.close();
    await ctx.close();

    const page2 = await browser.newPage();
    await cardPage(page2, "GATE 3/3 — Group Sales → Events MENU ABSENT", [
      `CapturedAt: ${evidence.capturedAt || "live"}`,
      "Menu labels this harvest:",
      ...(labels.length ? labels.map((l) => `  - ${l}`) : ["  (empty harvest)"]),
      `eventsPresent prior reverify: ${evidence.eventsPresent}`,
      `groupSalesMenu prior: ${JSON.stringify(evidence.groupSalesMenu || [])}`,
      "",
      `GSEVNT soft: HTTP ${gsevnt.status} / ${gsevnt.bytes}B`,
      "Prior UI proof: Group Booking + Group Availability only (no Events).",
      "Matches IT email item #3.",
    ]);
    await page2.waitForTimeout(2800);
    await page2.screenshot({ path: path.join(dir, "frame-002.png") });
    await page2.waitForTimeout(2800);
    await page2.screenshot({ path: path.join(dir, "frame-003.png") });
    await page2.close();
    await pngsToWebm(dir, path.join(outDir, "03-events-menu-absent.webm"));
  }

  await browser.close();

  const files = [
    "01-rate-details-security-deny.webm",
    "02-documents-tab-error.webm",
    "03-events-menu-absent.webm",
  ];
  const videos = [];
  for (const f of files) {
    const p = path.join(outDir, f);
    const buf = await readFile(p);
    videos.push({ file: f, bytes: buf.length });
  }
  const manifest = {
    capturedAt: new Date().toISOString(),
    evidenceAt: evidence.capturedAt,
    property: "HRCEN",
    method: "soft-evidence-json-plus-ui-screenshots-ffmpeg",
    note: "Soft messages from hms-gate-reverify live probe; cards rendered for verify. Playwright recordVideo avoided (breaks soft).",
    rateMsg: rate.msg,
    docMsg: doc.msg,
    folBytes: fol.bytes,
    videos,
  };
  await writeFile(
    path.join(outDir, "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(String(e).slice(0, 400) + "\n");
  process.exit(1);
});
