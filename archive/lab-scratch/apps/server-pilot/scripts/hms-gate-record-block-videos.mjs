/**
 * One soft session (no recordVideo) → overlay cards → PNG frames → ffmpeg webms.
 * Soft path copied from working hms-gate-reverify.mjs.
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

function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
    .replace(/\b\d{7,}\b/g, "[n]");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${code}: ${err.slice(-300)}`)),
    );
  });
}

async function overlay(page, { banner, card, caption }) {
  await page.evaluate(
    ({ banner, card, caption }) => {
      const ensure = (id, css) => {
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement("div");
          el.id = id;
          el.style.cssText = css;
          document.body.appendChild(el);
        }
        return el;
      };
      if (banner != null)
        ensure(
          "nava-b",
          "position:fixed;top:8px;left:10px;right:10px;z-index:2147483647;background:#8b0000;color:#fff;font:700 18px/1.3 sans-serif;padding:10px 12px;border-radius:8px;pointer-events:none;",
        ).textContent = banner;
      if (card != null)
        ensure(
          "nava-c",
          "position:fixed;top:64px;left:10px;right:10px;z-index:2147483647;background:rgba(15,15,15,.95);color:#ffe08a;font:14px/1.4 monospace;padding:12px 14px;border:3px solid #ff5555;border-radius:8px;white-space:pre-wrap;max-height:50vh;overflow:auto;pointer-events:none;",
        ).textContent = card;
      if (caption != null)
        ensure(
          "nava-f",
          "position:fixed;left:10px;right:10px;bottom:10px;z-index:2147483647;background:rgba(0,0,0,.9);color:#fff;font:15px/1.35 monospace;padding:10px 12px;border:2px solid #f5c542;border-radius:8px;white-space:pre-wrap;pointer-events:none;",
        ).textContent = caption;
    },
    { banner, card, caption },
  );
}

async function shot(page, dir, i, holdMs = 2800) {
  await page.waitForTimeout(holdMs);
  await page.screenshot({
    path: path.join(dir, `frame-${String(i).padStart(3, "0")}.png`),
    fullPage: false,
  });
}

async function pngsToWebm(framesDir, outWebm) {
  await run("ffmpeg", [
    "-y",
    "-framerate",
    "0.35",
    "-i",
    path.join(framesDir, "frame-%03d.png"),
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "1M",
    "-pix_fmt",
    "yuv420p",
    outWebm,
  ]);
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  await run("ffmpeg", ["-version"]);
  const outDir =
    process.env.GATE_VIDEO_OUT_DIR ||
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/gate-reverify/videos";
  await mkdir(outDir, { recursive: true });
  const exact = JSON.parse(
    await readFile(process.env.HMS_PROOF_EXACT_CANDIDATE_PATH, "utf8"),
  ).value;
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? "af-south-1",
  });
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.HMS_READ_SECRET_ARN }),
  );
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

  // Soft — identical structure to working gate-reverify
  const soft = await page.evaluate(async (exactConf) => {
    const scrubLocal = (s) =>
      String(s)
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email]")
        .replace(/\b\d{7,}\b/g, "[n]");
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
      await post(path, {
        SYSTEM_FUNCTION_NAME: "BSSTRT",
        USER_FUNCTION_NAME: "BSSTRT",
        manurefresh: "yes",
      }).catch(() => undefined);
    }
    await post("/web/base/OSRESS?FUNCTION_CLASS=WEBL", {
      SYSTEM_FUNCTION_NAME: "OSRESS",
      USER_FUNCTION_NAME: "OSRESS",
      FUNCTION_CLASS: "WEBL",
      CURRENT_TAB_NAME: "",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
    });
    const unused = "___NOMATCH___";
    const search = await post("/web/base/OSRESS.search", {
      COMPONENT_INFO_TYPE: "DATA_ONLY",
      GRID_ID: "1775",
      GRID_NAME: "OSRESS",
      DATASPY_ID: "1941",
      SYSTEM_FUNCTION_NAME: "OSRESS",
      USER_FUNCTION_NAME: "OSRESV",
      CURRENT_TAB_NAME: "LST",
      MADDON_FILTER_ALIAS_NAME_1: "departuredate",
      MADDON_FILTER_OPERATOR_1: ">=",
      MADDON_FILTER_JOINER_1: "AND",
      MADDON_FILTER_SEQNUM_1: "1",
      MADDON_FILTER_VALUE_1: "-365",
      MADDON_FILTER_ALIAS_NAME_2: "arrivaldate",
      MADDON_FILTER_OPERATOR_2: "<=",
      MADDON_FILTER_JOINER_2: "AND",
      MADDON_FILTER_SEQNUM_2: "2",
      MADDON_FILTER_VALUE_2: "+365",
      MADDON_FILTER_ALIAS_NAME_3: "confirmationnumber",
      MADDON_FILTER_OPERATOR_3: "BEGINS",
      MADDON_FILTER_JOINER_3: "OR",
      MADDON_FILTER_SEQNUM_3: "3",
      MADDON_FILTER_VALUE_3: exactConf,
      MADDON_LPAREN_3: "true",
      MADDON_FILTER_ALIAS_NAME_4: "room",
      MADDON_FILTER_OPERATOR_4: "=",
      MADDON_FILTER_JOINER_4: "OR",
      MADDON_FILTER_SEQNUM_4: "4",
      MADDON_FILTER_VALUE_4: unused,
      MADDON_FILTER_ALIAS_NAME_5: "lastname_filter",
      MADDON_FILTER_OPERATOR_5: "BEGINS",
      MADDON_FILTER_JOINER_5: "OR",
      MADDON_FILTER_SEQNUM_5: "5",
      MADDON_FILTER_VALUE_5: unused,
      MADDON_LPAREN_5: "false",
      MADDON_FILTER_ALIAS_NAME_6: "secondlastname",
      MADDON_FILTER_OPERATOR_6: "BEGINS",
      MADDON_FILTER_JOINER_6: "OR",
      MADDON_FILTER_SEQNUM_6: "6",
      MADDON_FILTER_VALUE_6: unused,
      MADDON_RPAREN_6: "false",
      MADDON_FILTER_ALIAS_NAME_7: "alternatelastname",
      MADDON_FILTER_OPERATOR_7: "BEGINS",
      MADDON_FILTER_JOINER_7: "OR",
      MADDON_FILTER_SEQNUM_7: "7",
      MADDON_FILTER_VALUE_7: unused,
      MADDON_FILTER_ALIAS_NAME_8: "aliaslastname",
      MADDON_FILTER_OPERATOR_8: "BEGINS",
      MADDON_FILTER_JOINER_8: "OR",
      MADDON_FILTER_SEQNUM_8: "8",
      MADDON_FILTER_VALUE_8: unused,
      MADDON_FILTER_ALIAS_NAME_9: "loyaltynumber",
      MADDON_FILTER_OPERATOR_9: "BEGINS",
      MADDON_FILTER_JOINER_9: "OR",
      MADDON_FILTER_SEQNUM_9: "9",
      MADDON_FILTER_VALUE_9: unused,
      MADDON_FILTER_ALIAS_NAME_10: "externalconfirmation",
      MADDON_FILTER_OPERATOR_10: "BEGINS",
      MADDON_FILTER_JOINER_10: "OR",
      MADDON_FILTER_SEQNUM_10: "10",
      MADDON_FILTER_VALUE_10: unused,
      MADDON_RPAREN_10: "true",
      externalconfirmation: unused,
    });
    if (!search.text.includes("pageData:")) {
      throw new Error(
        `search_fail bytes=${search.text.length} login=${/logindisp/i.test(search.text)}`,
      );
    }
    const marker = "pageData:";
    const idx = search.text.indexOf(marker);
    let i = idx + marker.length;
    while (i < search.text.length && /\s/.test(search.text[i])) i++;
    let depth = 0;
    let end = i;
    for (; end < search.text.length; end++) {
      if (search.text[end] === "{") depth++;
      else if (search.text[end] === "}") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    const pageData = JSON.parse(search.text.slice(i, end));
    const row = pageData.grid.GRIDRESULT.GRID.DATA[0];
    const stayId = String(row.id);
    const conf = String(row.confirmationnumber);
    const base = {
      confirmationnumber: conf,
      reservationstayid: stayId,
      id: stayId,
      propertycode: "HRCEN",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
      SYSTEM_FUNCTION_NAME: "OSRESV",
      USER_FUNCTION_NAME: "OSRESV",
    };
    const hdr = await post("/web/base/OSRESV.HDR", {
      ...base,
      CURRENT_TAB_NAME: "HDR",
    });
    const fol = await post("/web/base/OSRESV.FOL", {
      ...base,
      CURRENT_TAB_NAME: "FOL",
    });
    const rate = await post("/web/base/OSRESV?FUNCTION_CLASS=POPU", {
      ...base,
      USER_FUNCTION_NAME: "rate_gst",
      FUNCTION_CLASS: "POPU",
      CURRENT_TAB_NAME: "",
      ADD_TO_LAST_VISITED: "true",
      HANDLE_ID: "-1",
      COMPONENT: "1",
    });
    const doc = await post("/web/base/OSRESV.DOC", {
      ...base,
      CURRENT_TAB_NAME: "DOC",
      CURRENT_TABPK: "OSRESV_DOC",
      ADD_TO_LAST_VISITED: "true",
      HANDLE_ID: "-1",
      COMPONENT: "1",
      RECORDID: stayId,
    });
    const docFn = await post("/web/base/OSRESV?FUNCTION_CLASS=WEBL", {
      ...base,
      USER_FUNCTION_NAME: "DOC",
      FUNCTION_CLASS: "WEBL",
      CURRENT_TAB_NAME: "",
    });
    const gsevnt = await post("/web/base/GSEVNT?FUNCTION_CLASS=WEBL", {
      SYSTEM_FUNCTION_NAME: "GSEVNT",
      USER_FUNCTION_NAME: "GSEVNT",
      FUNCTION_CLASS: "WEBL",
      CURRENT_TAB_NAME: "",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
    });
    const gsgrpb = await post("/web/base/GSGRPB?FUNCTION_CLASS=WEBL", {
      SYSTEM_FUNCTION_NAME: "GSGRPB",
      USER_FUNCTION_NAME: "GSGRPB",
      FUNCTION_CLASS: "WEBL",
      CURRENT_TAB_NAME: "",
      MENU_MODULE_KEY: "0",
      removescreenflows: "yes",
    });
    const msg = (t) => {
      const m = /"msg"\s*:\s*"([^"]{0,200})"/.exec(t);
      return m ? scrubLocal(m[1]) : null;
    };
    return {
      hdrBytes: hdr.text.length,
      folBytes: fol.text.length,
      folClass: /"classPath"\s*:\s*"([^"]+)"/.exec(fol.text)?.[1] ?? null,
      ratedetailsVis:
        /"ratedetails"\s*:\s*"(optional|hidden|required|protected)"/i.exec(
          hdr.text,
        )?.[1] ?? null,
      docsflag: /"documentsflag"\s*:\s*"([^"]*)"/.exec(hdr.text)?.[1] ?? null,
      rate: { status: rate.status, bytes: rate.text.length, msg: msg(rate.text) },
      doc: { status: doc.status, bytes: doc.text.length, msg: msg(doc.text) },
      docFn: {
        status: docFn.status,
        bytes: docFn.text.length,
        msg: msg(docFn.text),
      },
      gsevnt: { status: gsevnt.status, bytes: gsevnt.text.length },
      gsgrpb: { status: gsgrpb.status, bytes: gsgrpb.text.length },
      stayIdLen: stayId.length,
    };
  }, exact);

  if (soft.folBytes < 1000) throw new Error(`fol bad ${soft.folBytes}`);
  if (!/security/i.test(soft.rate.msg || ""))
    throw new Error(`rate msg unexpected: ${soft.rate.msg}`);

  // --- VIDEO 01 frames ---
  const f1 = path.join(outDir, "_frames_01");
  await mkdir(f1, { recursive: true });
  await overlay(page, {
    banner: "GATE 1/3 — Front Desk → Guest Stay → Rate Details BLOCKED",
    card: [
      "LIVE PMS SAME SESSION (PII scrubbed)",
      `HDR bytes: ${soft.hdrBytes}`,
      `FOL bytes: ${soft.folBytes} class=${soft.folClass}  << Folio WORKS`,
      `ratedetails visibility: ${soft.ratedetailsVis}`,
      "",
      "Rate Details POPU (USER_FUNCTION_NAME=rate_gst):",
      `  HTTP ${soft.rate.status} / ${soft.rate.bytes}B`,
      `  msg: ${soft.rate.msg}`,
      "",
      "Verdict: Folio OK + Rate Details security deny = missing function rights.",
    ].join("\n"),
    caption: "IT email item #1 — Rate Details",
  });
  await shot(page, f1, 1, 2000);
  await shot(page, f1, 2, 3500);
  await shot(page, f1, 3, 3500);
  const w1 = path.join(outDir, "01-rate-details-security-deny.webm");
  await pngsToWebm(f1, w1);

  // --- VIDEO 02 frames (same soft results) ---
  const f2 = path.join(outDir, "_frames_02");
  await mkdir(f2, { recursive: true });
  await overlay(page, {
    banner: "GATE 2/3 — Guest Stay → Documents ERROR / SECURITY",
    card: [
      "LIVE PMS SAME SESSION (PII scrubbed)",
      `FOL bytes: ${soft.folBytes}  << Folio WORKS (stay keys valid)`,
      `documentsflag: ${soft.docsflag}`,
      "",
      "OSRESV.DOC:",
      `  HTTP ${soft.doc.status} / ${soft.doc.bytes}B`,
      `  msg: ${soft.doc.msg}`,
      "",
      "USER_FUNCTION_NAME=DOC WEBL:",
      `  HTTP ${soft.docFn.status} / ${soft.docFn.bytes}B`,
      `  msg: ${soft.docFn.msg}`,
      "",
      "IT email item #2 — Documents",
    ].join("\n"),
    caption: "Hold…",
  });
  await shot(page, f2, 1, 2000);
  await shot(page, f2, 2, 3500);
  await shot(page, f2, 3, 3500);
  const w2 = path.join(outDir, "02-documents-tab-error.webm");
  await pngsToWebm(f2, w2);

  // --- VIDEO 03: Group Sales UI + soft event codes ---
  const f3 = path.join(outDir, "_frames_03");
  await mkdir(f3, { recursive: true });
  await overlay(page, {
    banner: "GATE 3/3 — Group Sales → Events MENU ABSENT",
    caption: "Opening Group Sales menu…",
  });
  await shot(page, f3, 1, 1500);
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
  const labels = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll(".x-menu-item-text")]
          .map((n) => (n.textContent || "").trim())
          .filter(Boolean),
      ),
    ].slice(0, 40),
  );
  const events = labels.filter((t) => /event/i.test(t));
  await overlay(page, {
    banner: "GATE 3/3 — Group Sales → Events MENU ABSENT",
    card: [
      "GROUP SALES MENU LABELS (this harvest):",
      ...(labels.length ? labels.map((l) => `  - ${l}`) : ["  (empty — UI timing)"]),
      "",
      `Events labels: ${events.length ? events.join(", ") : "NONE"}`,
      "",
      "Soft-open same session:",
      `  GSGRPB (Group Booking): HTTP ${soft.gsgrpb.status} / ${soft.gsgrpb.bytes}B`,
      `  GSEVNT (Events guess): HTTP ${soft.gsevnt.status} / ${soft.gsevnt.bytes}B`,
      "",
      "Prior UI proof: submenu = Group Booking + Group Availability only.",
      "IT email item #3 — Events",
    ].join("\n"),
    caption: "Hold…",
  });
  await shot(page, f3, 2, 3500);
  await shot(page, f3, 3, 3500);
  await shot(page, f3, 4, 3000);
  const w3 = path.join(outDir, "03-events-menu-absent.webm");
  await pngsToWebm(f3, w3);

  await page.close();
  await ctx.close();
  await browser.close();

  const manifest = {
    capturedAt: new Date().toISOString(),
    property: "HRCEN",
    method: "one-soft-session-screenshots-ffmpeg",
    note: "No Playwright recordVideo (breaks soft). Soft path = hms-gate-reverify.",
    soft,
    labels,
    videos: [
      { file: "01-rate-details-security-deny.webm", bytes: (await readFile(w1)).length },
      { file: "02-documents-tab-error.webm", bytes: (await readFile(w2)).length },
      { file: "03-events-menu-absent.webm", bytes: (await readFile(w3)).length },
    ],
  };
  await writeFile(
    path.join(outDir, "MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 400) + "\n");
  process.exit(1);
});
