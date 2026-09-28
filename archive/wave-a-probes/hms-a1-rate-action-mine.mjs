/**
 * Menu-only Guest Stay → Run → mine Rate Details Ext button handler/action wiring.
 * Then soft-open harvested USER_FUNCTION / screen codes with exact stay keys.
 * Also DOC/TIV with stay keys (A3). HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_ACTION_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-action-mine.v1.json";
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

  // Menu-only Guest Stay (no OSRESS fetch)
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

  // Mine Rate Details / Rate Information / Documents buttons
  const mined = await page.evaluate(() => {
    const Ext = window.Ext;
    const out = [];
    const comps = [
      ...(Ext?.ComponentQuery?.query("button") ?? []),
      ...(Ext?.ComponentQuery?.query("menuitem") ?? []),
      ...(Ext?.ComponentQuery?.query("[tooltip]") ?? []),
    ];
    for (const c of comps) {
      const blob = [c.text, c.tooltip, c.qtip, c.icon, c.iconCls, c.itemId, c.action]
        .map((x) => String(x ?? ""))
        .join("|");
      if (!/rate.?detail|rate.?info|document|rate_gst|ratedetails/i.test(blob)) continue;
      let handlerSrc = null;
      try {
        if (typeof c.handler === "function") handlerSrc = c.handler.toString().slice(0, 800);
        else if (c.handler?.fn) handlerSrc = c.handler.fn.toString().slice(0, 800);
      } catch {
        /* ignore */
      }
      const initial = {};
      for (const k of Object.keys(c.initialConfig || {}).slice(0, 40)) {
        const v = c.initialConfig[k];
        if (v == null || typeof v === "function") continue;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") {
          initial[k] = String(v).slice(0, 120);
        } else if (Array.isArray(v)) {
          initial[k] = `array:${v.length}`;
        } else {
          initial[k] = `object:${Object.prototype.toString.call(v)}`;
        }
      }
      // Pull common Infor action fields without circular walk
      for (const k of [
        "functionName",
        "userFunctionName",
        "systemFunctionName",
        "screenName",
        "popupFunction",
        "openMode",
        "tabName",
        "url",
        "href",
      ]) {
        try {
          const v = c[k];
          if (v != null && typeof v !== "object" && typeof v !== "function") {
            initial[`prop_${k}`] = String(v).slice(0, 80);
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        text: String(c.text ?? "").slice(0, 50),
        tooltip: String(c.tooltip ?? c.qtip ?? "").slice(0, 50),
        icon: String(c.icon ?? c.iconCls ?? "").slice(0, 50),
        itemId: String(c.itemId ?? "").slice(0, 40),
        action: String(c.action ?? "").slice(0, 40),
        disabled: Boolean(c.disabled),
        hidden: Boolean(c.hidden || c.isHidden?.()),
        handlerSrc,
        initial,
      });
    }
    // Also scan page scripts / window for rate_gst openPopup patterns
    const snips = [];
    const html = document.documentElement.innerHTML;
    const re = /rate_gst|ratedetails|openPopup|openScreen|USER_FUNCTION_NAME.{0,40}rate/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(html)) && snips.length < 15) {
      const s = html.slice(Math.max(0, m.index - 60), Math.min(html.length, m.index + 100)).replace(/\s+/g, " ");
      if (!seen.has(s)) {
        seen.add(s);
        snips.push(s);
      }
    }
    return { buttons: out.slice(0, 20), snips };
  });

  // Soft-open exact stay via fetch (keep Ext session) — FOL pattern
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
    // Prefer OSRESS.search for exact stay (do NOT open OSRESS WEBL — kills Ext)
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
    const marker = "pageData:";
    const idx = search.text.indexOf(marker);
    if (idx < 0) return { ok: false, reason: "no_pageData", searchBytes: search.text.length };
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
    await post("/web/base/OSRESV.HDR", { ...base, CURRENT_TAB_NAME: "HDR" });

    const probes = {};
    const specs = [
      { name: "DOC", path: "/web/base/OSRESV.DOC", body: { ...base, CURRENT_TAB_NAME: "DOC" } },
      { name: "TIV", path: "/web/base/OSRESV.TIV", body: { ...base, CURRENT_TAB_NAME: "TIV" } },
      { name: "FOL", path: "/web/base/OSRESV.FOL", body: { ...base, CURRENT_TAB_NAME: "FOL" } },
      {
        name: "rate_gst POPU",
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        body: { ...base, USER_FUNCTION_NAME: "rate_gst", FUNCTION_CLASS: "POPU", CURRENT_TAB_NAME: "" },
      },
      {
        name: "ratedetails POPU",
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        body: { ...base, USER_FUNCTION_NAME: "ratedetails", FUNCTION_CLASS: "POPU", CURRENT_TAB_NAME: "" },
      },
      {
        name: "rate_gst WEBL",
        path: "/web/base/OSRESV?FUNCTION_CLASS=WEBL",
        body: { ...base, USER_FUNCTION_NAME: "rate_gst", FUNCTION_CLASS: "WEBL", CURRENT_TAB_NAME: "" },
      },
      {
        name: "OSRRD / OSRESV.RDT",
        path: "/web/base/OSRESV.RDT",
        body: { ...base, CURRENT_TAB_NAME: "RDT" },
      },
      {
        name: "OSRDTL WEBL",
        path: "/web/base/OSRDTL?FUNCTION_CLASS=WEBL",
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: "OSRDTL",
          USER_FUNCTION_NAME: "OSRDTL",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
        },
      },
      {
        name: "OSRATE WEBL",
        path: "/web/base/OSRATE?FUNCTION_CLASS=WEBL",
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: "OSRATE",
          USER_FUNCTION_NAME: "OSRATE",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
        },
      },
      {
        name: "OSRGST WEBL",
        path: "/web/base/OSRGST?FUNCTION_CLASS=WEBL",
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: "OSRGST",
          USER_FUNCTION_NAME: "OSRGST",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
        },
      },
    ];
    for (const spec of specs) {
      const r = await post(spec.path, spec.body);
      probes[spec.name] = {
        status: r.status,
        bytes: r.text.length,
        classPath: /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null,
        msg: (() => {
          const m = /"msg"\s*:\s*"([^"]{0,160})"/.exec(r.text);
          return m ? scrubLocal(m[1]) : null;
        })(),
        labels: [
          ...new Set(
            [...r.text.matchAll(/"label"\s*:\s*"([^"]{2,50})"/g)].map((x) => x[1]),
          ),
        ].slice(0, 12),
        rateish: [
          ...new Set(
            [...r.text.matchAll(/"(rate[^"\\n]{0,30}|night[^"\\n]{0,30}|schedule[^"\\n]{0,30}|document[^"\\n]{0,30})"/gi)].map(
              (x) => x[1],
            ),
          ),
        ].slice(0, 15),
      };
    }
    return { ok: true, probes };
  }, exact);

  // After soft HDR, try Ext Rate Details click again
  const mark = xhr.length;
  const rateClick = await page.evaluate(() => {
    const Ext = window.Ext;
    const hits = [];
    for (const c of Ext?.ComponentQuery?.query("button") ?? []) {
      const blob = [c.text, c.tooltip, c.icon].join(" ");
      if (!/rate.?detail/i.test(blob)) continue;
      hits.push({
        text: String(c.text || "").slice(0, 40),
        disabled: Boolean(c.disabled),
        hidden: Boolean(c.hidden || c.isHidden?.()),
      });
      try {
        c.enable?.();
        if (typeof c.handler === "function") c.handler(c);
        else if (c.handler?.fn) c.handler.fn.call(c.handler.scope || c, c);
        c.fireEvent?.("click", c);
        c.el?.dom?.click();
      } catch (e) {
        hits.push({ err: String(e).slice(0, 100) });
      }
    }
    return hits;
  });
  await page.waitForTimeout(5_000);

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    mined,
    soft,
    rateClick,
    xhrAfterRate: xhr.slice(mark),
    xhrTail: xhr.slice(-25),
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      buttons: mined.buttons.map((b) => ({
        text: b.text,
        icon: b.icon,
        disabled: b.disabled,
        hidden: b.hidden,
        action: b.action,
        itemId: b.itemId,
        handlerLen: b.handlerSrc?.length ?? 0,
        handlerHead: b.handlerSrc?.slice(0, 200) ?? null,
        initialKeys: Object.keys(b.initial || {}),
      })),
      snips: mined.snips,
      softOk: soft.ok,
      probes: soft.probes,
      rateClick,
      xhrAfterRate: out.xhrAfterRate,
    }) + "\n",
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
