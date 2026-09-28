#!/usr/bin/env python3
"""Patch /tmp/nava-wavea-reservation-detail-facade.js to click Rate Details after dump."""
from pathlib import Path
import shutil

src = Path("/tmp/nava-wavea-reservation-detail-facade.js")
t = src.read_text()
old = """            if (collected.searchChrome && collected.filledNonSearch < 3) {
                throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail open still on search chrome (no stay fields filled)');
            }
            return dumpFromForm(collected, Boolean(options?.captureValues));
        },
    };
}
"""
insert = """            if (collected.searchChrome && collected.filledNonSearch < 3) {
                throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail open still on search chrome (no stay fields filled)');
            }
            const baseDump = dumpFromForm(collected, Boolean(options?.captureValues));
            // Wave A1: try Rate Details toolbar after detail open (read-only).
            try {
                const clicked = await page.evaluateStableDom(() => {
                    const doc = globalThis.document;
                    if (!doc) return false;
                    const imgs = Array.from(doc.querySelectorAll('img'));
                    for (const img of imgs) {
                        const srcAttr = img.getAttribute('src') || '';
                        const title = img.getAttribute('title') || img.getAttribute('data-qtip') || '';
                        if (/rate-details/i.test(srcAttr) || /rate\\s*detail/i.test(title)) {
                            img.click();
                            const parent = img.closest('a,button,div,span');
                            if (parent) parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                            return true;
                        }
                    }
                    return false;
                });
                if (clicked) {
                    await new Promise((r) => setTimeout(r, 4000));
                    const rateCollected = await collectFormKeys(page);
                    const rateKeys = rateCollected.keys.filter((k) => !SEARCH_CHROME_KEYS.has(k));
                    return {
                        ...baseDump,
                        keys: Array.from(new Set([...(baseDump.keys || []), ...rateKeys.map((k) => `ratedetails.${k}`)])).sort(),
                        rateDetailsClicked: true,
                        rateDetailsKeyCount: rateKeys.length,
                    };
                }
            } catch {
                /* keep base dump */
            }
            return { ...baseDump, rateDetailsClicked: false };
        },
    };
}
"""
if old not in t:
    idx = t.rfind("return dumpFromForm(collected")
    raise SystemExit(f"pattern missing; last dumpFromForm at {idx}")
t2 = t.replace(old, insert, 1)
backup = Path("/tmp/nava-wavea-reservation-detail-facade.js.bak-a1")
if not backup.exists():
    shutil.copy(src, backup)
Path("/tmp/nava-wavea-reservation-detail-facade.rate.js").write_text(t2)
shutil.copy("/tmp/nava-wavea-reservation-detail-facade.rate.js", src)
print(f"patched ok len {len(t)} -> {len(t2)}")
