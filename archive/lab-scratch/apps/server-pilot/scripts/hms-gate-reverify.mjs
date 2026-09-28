/**
 * Re-verify EXTERNAL_ROLE_GATE claims with alt probes (falsify-our-mistake).
 * 1) After exact search+HDR: invoke Rate Details via screenflow tokens mined from HDR
 * 2) DOC with HANDLE_ID/COMPONENT/RECORDID variants
 * 3) Menu harvest: Events still absent?
 * HMS_DISCOVERY_ALLOW_LIVE=1. No PII printed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== "1") throw new Error("refused");
  const arn = process.env.HMS_READ_SECRET_ARN;
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  const outPath =
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/gate-reverify/reprobe.v1.json";
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
    )
      return route.abort();
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
  await page.waitForTimeout(5_000);

  // --- Part A: soft probes after clean OSRESS.search + HDR ---
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
    // Mine HDR for openScreen / popup / rate_gst wiring snippets
    const snips = [];
    const re =
      /rate_gst|ratedetails|openPopup|openScreen|FUNCTION_CLASS|screenflow|popupfunction|userfunction|rate_lse/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(hdr.text)) && snips.length < 20) {
      const s = scrubLocal(
        hdr.text.slice(Math.max(0, m.index - 100), Math.min(hdr.text.length, m.index + 140)),
      ).replace(/\s+/g, " ");
      if (!seen.has(s)) {
        seen.add(s);
        snips.push(s);
      }
    }
    const ratedetailsVis =
      /"ratedetails"\s*:\s*"(optional|hidden|required|protected)"/i.exec(hdr.text)?.[1] ??
      null;
    const docsflag = /"documentsflag"\s*:\s*"([^"]*)"/.exec(hdr.text)?.[1] ?? null;

    const probes = {};
    const specs = [
      {
        name: "rate_gst POPU after HDR",
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        body: {
          ...base,
          USER_FUNCTION_NAME: "rate_gst",
          FUNCTION_CLASS: "POPU",
          CURRENT_TAB_NAME: "",
          ADD_TO_LAST_VISITED: "true",
          HANDLE_ID: "-1",
          COMPONENT: "1",
        },
      },
      {
        name: "rate_gst as USER under OSRESS POPU",
        path: "/web/base/OSRESS?FUNCTION_CLASS=POPU",
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: "OSRESS",
          USER_FUNCTION_NAME: "rate_gst",
          FUNCTION_CLASS: "POPU",
          CURRENT_TAB_NAME: "",
        },
      },
      {
        name: "OSRESV path USER=rate_gst no class",
        path: "/web/base/OSRESV",
        body: {
          ...base,
          USER_FUNCTION_NAME: "rate_gst",
          CURRENT_TAB_NAME: "",
          ADD_TO_LAST_VISITED: "true",
        },
      },
      {
        name: "DOC after HDR + HANDLE",
        path: "/web/base/OSRESV.DOC",
        body: {
          ...base,
          CURRENT_TAB_NAME: "DOC",
          CURRENT_TABPK: "OSRESV_DOC",
          ADD_TO_LAST_VISITED: "true",
          HANDLE_ID: "-1",
          COMPONENT: "1",
          RECORDID: stayId,
        },
      },
      {
        name: "DOC RECORDID only",
        path: "/web/base/OSRESV.DOC",
        body: {
          SYSTEM_FUNCTION_NAME: "OSRESV",
          USER_FUNCTION_NAME: "OSRESV",
          CURRENT_TAB_NAME: "DOC",
          RECORDID: stayId,
          MENU_MODULE_KEY: "0",
          removescreenflows: "yes",
        },
      },
      {
        name: "FOL control",
        path: "/web/base/OSRESV.FOL",
        body: { ...base, CURRENT_TAB_NAME: "FOL" },
      },
      // Event guesses again after warm
      {
        name: "GSEVNT WEBL",
        path: "/web/base/GSEVNT?FUNCTION_CLASS=WEBL",
        body: {
          SYSTEM_FUNCTION_NAME: "GSEVNT",
          USER_FUNCTION_NAME: "GSEVNT",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
          MENU_MODULE_KEY: "0",
          removescreenflows: "yes",
        },
      },
      {
        name: "OSEVNT WEBL",
        path: "/web/base/OSEVNT?FUNCTION_CLASS=WEBL",
        body: {
          SYSTEM_FUNCTION_NAME: "OSEVNT",
          USER_FUNCTION_NAME: "OSEVNT",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
          MENU_MODULE_KEY: "0",
          removescreenflows: "yes",
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
          const mm = /"msg"\s*:\s*"([^"]{0,180})"/.exec(r.text);
          return mm ? scrubLocal(mm[1]) : null;
        })(),
      };
    }
    return {
      hdrBytes: hdr.text.length,
      ratedetailsVis,
      docsflag,
      snips,
      probes,
    };
  }, exact);

  // --- Part B: fresh UI session for Events menu + Rate Details after true Run ---
  // Soft OSRESS may have polluted Ext — open new page
  const page2 = await ctx.newPage();
  const xhr = [];
  page2.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? "");
    xhr.push({
      path: m[1].toUpperCase(),
      user: params.get("USER_FUNCTION_NAME"),
      cls: params.get("FUNCTION_CLASS"),
      tab: params.get("CURRENT_TAB_NAME"),
    });
  });
  await page2.goto(secret.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page2
    .locator("input[name=userid], input[name=username], input[name=j_username]")
    .first()
    .fill(secret.username);
  await page2.locator("input[name=password]").fill(secret.password);
  await Promise.all([
    page2.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page2.getByRole("button", { name: "Sign in" }).click().catch(async () => {
      await page2.locator("input[name=password]").press("Enter");
    }),
  ]);
  await page2.waitForTimeout(8_000);

  // Group Sales submenu labels
  await page2.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  await page2.waitForTimeout(1_200);
  await page2.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Group Sales",
    );
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page2.waitForTimeout(2_000);
  const groupSalesMenu = await page2.evaluate(() =>
    [...new Set([...document.querySelectorAll(".x-menu-item-text")].map((n) => (n.textContent || "").trim()).filter(Boolean))].slice(0, 30),
  );

  // Front Desk → Guest Stay → Run → select → show ratedetails menu → click rate_gst
  await page2.evaluate(() => {
    const more = [...document.querySelectorAll("a,span,button")].find(
      (n) => (n.textContent || "").trim() === "More",
    );
    if (more) more.click();
  });
  await page2.waitForTimeout(800);
  await page2.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Front Desk",
    );
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.click();
    }
  });
  await page2.waitForTimeout(1_500);
  await page2.evaluate(() => {
    const el = [...document.querySelectorAll(".x-menu-item-text, span, a")].find(
      (n) => (n.textContent || "").trim() === "Guest Stay",
    );
    if (el) el.click();
  });
  await page2.waitForTimeout(8_000);
  await page2.evaluate(() => {
    const el = [...document.querySelectorAll(".x-btn-inner, button, span")].find(
      (n) => (n.textContent || "").trim() === "Run",
    );
    if (el) el.click();
  });
  await page2.waitForTimeout(10_000);

  const mark = xhr.length;
  const uiRate = await page2.evaluate(() => {
    const Ext = window.Ext;
    const gs = Ext?.ComponentQuery?.query("grid") ?? [];
    const grid = gs.find((g) => (g.store?.getCount?.() ?? 0) > 0);
    if (grid) {
      const rec = grid.store.getAt(0);
      grid.getSelectionModel?.().select(rec);
      try {
        grid.fireEvent("itemdblclick", grid, rec);
      } catch {
        /* ignore */
      }
    }
    // Wait-ish done outside
    const items = Ext?.ComponentQuery?.query("menuitem") ?? [];
    const mi = items.find((i) => String(i.action ?? "") === "rate_gst");
    const out = {
      gridCount: grid?.store?.getCount?.() ?? 0,
      menuitemFound: Boolean(mi),
      menuitemHidden: mi ? Boolean(mi.hidden) : null,
      menuitemDisabled: mi ? Boolean(mi.disabled) : null,
    };
    if (mi) {
      try {
        mi.up?.("menu")?.show?.();
        mi.show?.();
        mi.enable?.();
        if (typeof mi.handler === "function") mi.handler(mi);
        else if (mi.handler?.fn) mi.handler.fn.call(mi.handler.scope || mi, mi);
        mi.fireEvent?.("click", mi);
        mi.el?.dom?.click();
      } catch (e) {
        out.err = String(e).slice(0, 120);
      }
    }
    // Also try button_ratedetails showMenu
    for (const b of Ext?.ComponentQuery?.query("button") ?? []) {
      if (!/button_ratedetails/i.test(String(b.iconCls || b.icon || ""))) continue;
      try {
        b.show?.();
        b.setVisible?.(true);
        b.showMenu?.();
        b.menu?.show?.();
        out.buttonShown = true;
      } catch {
        /* ignore */
      }
    }
    const dialogs = [...document.querySelectorAll(".x-window, .x-message-box")]
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 180))
      .filter((t) => /security|rights|rate detail|permission|error|insufficient/i.test(t))
      .slice(0, 5);
    out.dialogs = dialogs;
    return out;
  });
  await page2.waitForTimeout(6_000);

  const out = {
    capturedAt: new Date().toISOString(),
    soft,
    groupSalesMenu,
    eventsPresent: groupSalesMenu.some((t) => /event/i.test(t)),
    uiRate,
    xhrAfterRate: xhr.slice(mark),
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
