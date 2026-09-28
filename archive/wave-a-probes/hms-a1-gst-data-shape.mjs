import { chromium } from "playwright";
import { createHmsSession } from "../src/hms/session.ts";
import { loadExactCandidate } from "../src/hms/live-proof-helpers.ts";
import { writeFileSync, mkdirSync } from "node:fs";

function walk(node, path, out) {
  if (out.length >= 80) return;
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    out.push({ path, kind: "array", n: node.length, firstType: node[0] ? typeof node[0] : "empty" });
    if (node[0] && typeof node[0] === "object") {
      const k = Object.keys(node[0]);
      out.push({
        path: path + "[0].keys",
        n: k.length,
        sample: k.slice(0, 40),
        rateish: k.filter((x) => /rate|night|amount|price|occup|gst|roomtype|plan/i.test(x)).slice(0, 30),
      });
      walk(node[0], path + "[0]", out);
    }
    return;
  }
  const keys = Object.keys(node);
  for (const k of keys) {
    if (["DATA", "items", "records", "GRID", "rows"].includes(k) || /rate|night/i.test(k)) {
      walk(node[k], path + "." + k, out);
    }
  }
}

const session = await createHmsSession({ chromium, headless: true });
try {
  await session.ensureLoggedIn();
  const rec = loadExactCandidate();
  const value = rec.confirmation;
  const search = await session.callXml("OSRESS.search", {
    GRID: { CURRENT_TABPK: "OSRESS", DATASPY: { DEFAULT: true, DATASPY_ID: 1941 }, FILTERS: { FIELD: [] } },
    CURRENT_TABPK: "OSRESS",
    ADD_TO_LAST_VISITED: true,
    HANDLE_ID: -1,
    COMPONENT: 1,
    NUMBER_OF_LINES_ON_TAB: 0,
  });
  const row = (search.response.DATA || []).find((r) => String(r.confirmnumber ?? r.reservationid) === String(value));
  const recId = String(row.reservationid);
  await session.callXml("OSRESV.HDR", { RECORDID: recId, CURRENT_TABPK: "OSRESV", ADD_TO_LAST_VISITED: true });
  const gst = await session.callXml("OSRESV.GST", {
    RECORDID: recId,
    CURRENT_TABPK: "OSRESV_GST",
    ADD_TO_LAST_VISITED: true,
    HANDLE_ID: -1,
    COMPONENT: 1,
  });
  const shape = [];
  walk(gst.response, "gst", shape);
  const top = Object.keys(gst.response || {}).slice(0, 80);
  mkdirSync("/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload", { recursive: true });
  writeFileSync(
    "/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/osresv-gst-shape.v1.json",
    JSON.stringify({ top, shape, recIdLen: recId.length }, null, 2),
  );
  console.log(JSON.stringify({ top, shape }, null, 2));
} finally {
  await session.close();
}
