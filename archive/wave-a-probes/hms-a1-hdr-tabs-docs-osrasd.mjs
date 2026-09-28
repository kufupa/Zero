/**
 * After OSRESS.search + OSRESV.HDR:
 *  - dump tabPKFields / visibility flags
 *  - probe every HDR tab + DOC/DOCS/ATT + Rate Shop OSRASD + rate_lse/rateinfo POPU
 *  - DOM-click Guest Stay grid (A8 pattern) and list toolbar/tab titles
 * No PII. HMS_DISCOVERY_ALLOW_LIVE=1.
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

function parsePageData(text) {
  const marker = "pageData:";
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  let i = idx + marker.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  let depth = 0;
  let end = i;
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  try {
    return JSON.parse(text.slice(i, end));
  } catch {
    return null;
  }
}

function walkTabs(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const x of node) walkTabs(x, out, depth + 1);
    return;
  }
  const name = node.tabname || node.TABNAME || node.name || node.pk || node.tabPK;
  const label = node.label || node.title || node.caption || node.text;
  if (name || label) {
    out.push({
      name: name ? String(name).slice(0, 40) : null,
      label: label ? String(label).slice(0, 60) : null,
    });
  }
  for (const k of ["tabPKFields", "items", "tabs", "TAB", "children"]) {
    if (node[k]) walkTabs(node[k], out, depth + 1);
  }
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  const arn = process.env.HMS_READ_SECRET_ARN;
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  const outPath =
    process.env.HMS_A1_TABS_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/hdr-tabs-docs-osrasd.v1.json";
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
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print|send)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
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
  await page.waitForTimeout(4_000);

  const fetchOut = await page.evaluate(async (exactConf) => {
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
    const parsePd = (text) => {
      const marker = "pageData:";
      const idx = text.indexOf(marker);
      if (idx < 0) return null;
      let i = idx + marker.length;
      while (i < text.length && /\s/.test(text[i])) i++;
      let depth = 0;
      let end = i;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}") {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      try {
        return JSON.parse(text.slice(i, end));
      } catch {
        return null;
      }
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
    const pageData = parsePd(search.text);
    const row = pageData?.grid?.GRIDRESULT?.GRID?.DATA?.[0];
    if (!row) return { ok: false, reason: "no_row", searchBytes: search.text.length };
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
    const hdrPd = parsePd(hdr.text);
    const vis = {};
    const visKeys = [
      "ratedetails",
      "ratedetailsmenu",
      "rateinformation",
      "documents",
      "documentstab",
      "documentsflag",
      "rateshop",
      "rateshopflag",
    ];
    const blob = hdrPd || {};
    const flat = (obj, prefix, acc, d = 0) => {
      if (!obj || typeof obj !== "object" || d > 4) return;
      if (Array.isArray(obj)) return;
      for (const [k, v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (
          /rate|document|tabpk|shop|lease|gst|folio|trace|note/i.test(lk) &&
          (typeof v === "string" || typeof v === "boolean" || v == null)
        ) {
          acc[prefix + k] = v == null ? null : String(v).slice(0, 80);
        }
        if (d < 2 && v && typeof v === "object" && !Array.isArray(v)) {
          flat(v, prefix + k + ".", acc, d + 1);
        }
      }
    };
    const flags = {};
    flat(blob, "", flags);
    for (const k of visKeys) vis[k] = flags[k] ?? flags[k.toLowerCase()] ?? null;

    const tabHits = [];
    const collectTabs = (node, d = 0) => {
      if (!node || typeof node !== "object" || d > 6 || tabHits.length > 80) return;
      if (Array.isArray(node)) {
        for (const x of node) collectTabs(x, d + 1);
        return;
      }
      const name = node.tabname || node.TABNAME || node.tabPK || node.pk || node.name;
      const label = node.label || node.title || node.caption || node.text;
      if (typeof name === "string" || typeof label === "string") {
        tabHits.push({
          name: name ? String(name).slice(0, 40) : null,
          label: label ? String(label).slice(0, 60) : null,
        });
      }
      for (const k of ["tabPKFields", "items", "tabs", "TAB", "children"]) {
        if (node[k]) collectTabs(node[k], d + 1);
      }
    };
    collectTabs(hdrPd);

    const tabCodes = [
      ...new Set(
        tabHits
          .map((t) => t.name)
          .filter(Boolean)
          .filter((n) => /^[A-Z0-9_.]{2,12}$/i.test(n)),
      ),
    ];
    const extraTabs = [
      "GST",
      "FOL",
      "TRC",
      "NOT",
      "DOC",
      "DOCS",
      "ATT",
      "UPL",
      "GSD",
      "GDOC",
      "SHS",
      "SHR",
      "PKG",
      "ALC",
    ];
    const probes = {};
    for (const tab of [...new Set([...tabCodes, ...extraTabs])]) {
      const r = await post(`/web/base/OSRESV.${tab}`, {
        ...base,
        CURRENT_TAB_NAME: tab,
      });
      const cp = /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null;
      const msg = /"msg"\s*:\s*"([^"]{0,160})"/.exec(r.text)?.[1] ?? null;
      const labels = [
        ...new Set(
          [...r.text.matchAll(/"label"\s*:\s*"([^"]{2,50})"/g)].map((x) => x[1]),
        ),
      ].slice(0, 12);
      probes[`OSRESV.${tab}`] = {
        status: r.status,
        bytes: r.text.length,
        classPath: cp,
        msg: msg ? scrubLocal(msg) : null,
        labels,
      };
    }

    const extraFns = [
      { path: "/web/base/OSRASD?FUNCTION_CLASS=WEBL", fn: "OSRASD", cls: "WEBL" },
      { path: "/web/base/OSRASD.HDR", fn: "OSRASD", cls: null, tab: "HDR" },
      {
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        fn: "rate_lse",
        cls: "POPU",
      },
      {
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        fn: "rateinfo",
        cls: "POPU",
      },
      {
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        fn: "rateinformation",
        cls: "POPU",
      },
    ];
    for (const spec of extraFns) {
      const body = {
        ...base,
        SYSTEM_FUNCTION_NAME: spec.fn === "OSRASD" ? "OSRASD" : "OSRESV",
        USER_FUNCTION_NAME: spec.fn,
        MENU_MODULE_KEY: "0",
        removescreenflows: "yes",
      };
      if (spec.cls) body.FUNCTION_CLASS = spec.cls;
      if (spec.tab) body.CURRENT_TAB_NAME = spec.tab;
      const r = await post(spec.path, body);
      const cp = /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null;
      const msg = /"msg"\s*:\s*"([^"]{0,160})"/.exec(r.text)?.[1] ?? null;
      probes[`${spec.fn}/${spec.cls || spec.tab || "plain"}`] = {
        status: r.status,
        bytes: r.text.length,
        classPath: cp,
        msg: msg ? scrubLocal(msg) : null,
      };
    }

    const hdrKeys = hdrPd ? Object.keys(hdrPd).slice(0, 80) : [];
    return {
      ok: true,
      hdrBytes: hdr.text.length,
      hdrKeys,
      vis,
      flagSample: Object.fromEntries(Object.entries(flags).slice(0, 60)),
      tabHits: tabHits.slice(0, 40),
      tabCodes,
      probes,
    };
  }, exact);

  // DOM path: More → Front Desk → Guest Stay, click grid row, list tabs/toolbar
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
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Guest Stay",
    );
    if (el) el.click();
  });
  await page.waitForTimeout(5_000);
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
  await page.waitForTimeout(4_000);
  const ui = await page.evaluate(() => {
    const texts = [
      ...new Set(
        [
          ...document.querySelectorAll(
            ".x-tab-inner, .x-btn-inner, .x-menu-item-text, a.x-tab",
          ),
        ]
          .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 1 && t.length < 48),
      ),
    ].slice(0, 80);
    const imgs = [...document.querySelectorAll("img")]
      .map((i) => ({
        src: (i.getAttribute("src") || "").slice(-80),
        title: i.getAttribute("title") || i.getAttribute("data-qtip") || "",
      }))
      .filter((x) => /rate|toolbar|document|detail/i.test(x.src + x.title))
      .slice(0, 40);
    return { texts, imgs, imgCount: document.querySelectorAll("img").length };
  });

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    fetchOut,
    rowClick,
    ui,
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  const probeSummary = Object.fromEntries(
    Object.entries(fetchOut.probes || {}).map(([k, v]) => [
      k,
      `${v.status}/${v.bytes}/cp=${v.classPath || ""}/msg=${v.msg || ""}`,
    ]),
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      hdrBytes: fetchOut.hdrBytes,
      tabCodes: fetchOut.tabCodes,
      vis: fetchOut.vis,
      flagSample: fetchOut.flagSample,
      tabHits: fetchOut.tabHits,
      probeSummary,
      rowClick,
      uiTexts: ui.texts,
      uiImgs: ui.imgs,
      imgCount: ui.imgCount,
    }) + "\n",
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(
    scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n",
  );
  process.exit(1);
});
