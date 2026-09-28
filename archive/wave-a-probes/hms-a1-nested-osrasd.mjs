/**
 * Dump nested HDR objects (rateinformationcard/ratedetails/nights) + OSRASD with stay ids.
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
    process.env.HMS_A1_NEST_OUT ??
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/hdr-nested-osrasd.v1.json";
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete|generate|print)/i.test(
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
  await page.waitForTimeout(4_000);

  const out = await page.evaluate(async (exactConf) => {
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
    const parseBalanced = (text, startIdx) => {
      let i = startIdx;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== "{" && text[i] !== "[") return { json: null, raw: text.slice(i, i + 80) };
      const open = text[i];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let end = i;
      for (; end < text.length; end++) {
        const c = text[end];
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      const raw = text.slice(i, end);
      try {
        return { json: JSON.parse(raw), rawLen: raw.length };
      } catch {
        return { json: null, rawLen: raw.length };
      }
    };
    const shape = (val, d = 0) => {
      if (val == null) return null;
      if (typeof val !== "object") return typeof val;
      if (Array.isArray(val)) {
        return {
          kind: "array",
          n: val.length,
          firstKeys:
            val[0] && typeof val[0] === "object" ? Object.keys(val[0]).slice(0, 25) : typeof val[0],
        };
      }
      const keys = Object.keys(val);
      const out = { kind: "object", keys: keys.slice(0, 40) };
      if (d < 1) {
        out.child = {};
        for (const k of keys.slice(0, 20)) {
          const v = val[k];
          if (v && typeof v === "object") out.child[k] = shape(v, d + 1);
        }
      }
      return out;
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
    const t = hdr.text;
    const nested = {};
    for (const key of [
      "rateinformationcard",
      "ratedetails",
      "nights",
      "nightsvalue",
      "depositschedule",
      "grouprateschedulecode",
      "averagerate",
      "rateplan",
      "printmenu",
      "emailicon",
    ]) {
      const re = new RegExp(`"${key}"\\s*:`, "i");
      const m = re.exec(t);
      if (!m) {
        nested[key] = { missing: true };
        continue;
      }
      const parsed = parseBalanced(t, m.index + m[0].length);
      nested[key] = parsed.json ? shape(parsed.json) : { parseFail: true, rawLen: parsed.rawLen };
    }
    const probes = {};
    const specs = [
      {
        name: "OSRASD+stay",
        path: "/web/base/OSRASD?FUNCTION_CLASS=WEBL",
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: "OSRASD",
          USER_FUNCTION_NAME: "OSRASD",
          FUNCTION_CLASS: "WEBL",
          CURRENT_TAB_NAME: "",
        },
      },
      {
        name: "OSRASD.HDR+stay",
        path: "/web/base/OSRASD.HDR",
        body: { ...base, SYSTEM_FUNCTION_NAME: "OSRASD", USER_FUNCTION_NAME: "OSRASD", CURRENT_TAB_NAME: "HDR" },
      },
      {
        name: "OSRESV USER=OSRASD POPU",
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        body: { ...base, USER_FUNCTION_NAME: "OSRASD", FUNCTION_CLASS: "POPU", CURRENT_TAB_NAME: "" },
      },
      {
        name: "OSRESV USER=rateshop POPU",
        path: "/web/base/OSRESV?FUNCTION_CLASS=POPU",
        body: { ...base, USER_FUNCTION_NAME: "rateshop", FUNCTION_CLASS: "POPU", CURRENT_TAB_NAME: "" },
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
        ].slice(0, 15),
      };
    }
    return { nested, probes };
  }, exact);

  await mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify(out) + "\n");
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : "fail").slice(0, 240) + "\n");
  process.exit(1);
});
