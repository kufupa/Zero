/**
 * Structure-only PSSNEL.HDR inventory (field/toolbar/grid names).
 * Never extracts row values, addresses, subjects, or filenames.
 */

export type PssnelHdrStructure = {
  hdrBytes: number;
  fieldNamesSample: string[];
  toolbarSample: string[];
  gridCols: string[];
  hasSentEmailToolbar: boolean;
  envelopeRecognized: boolean;
};

const GRID_COL_RE =
  /"name"\s*:\s*"(emailtype|account|accountname|subject|emailaddress|attachment|userid|reportcode|error|emaildate|property|reportparameterlist|report|dbemaildatetime)"/gi;

/**
 * Extract sanitized structural markers from a PSSNEL.HDR response body.
 * Live-faithful against Wave A3 ~28kB open (field/toolbar/grid names only).
 */
export function extractPssnelHdrStructure(text: string): PssnelHdrStructure {
  const hdrBytes = Buffer.byteLength(text);
  const fieldNamesSample = [
    ...text.matchAll(/"name"\s*:\s*"([a-zA-Z0-9_]{2,48})"/g),
  ]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 120);

  const toolbarSample = [
    ...text.matchAll(/"label"\s*:\s*"([^"]{1,60})"/g),
  ]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i)
    .filter((l) =>
      /print|email|send|resend|export|generate|open|attach|search|new|delete|save|type|address|all sent/i.test(
        l,
      ),
    )
    .slice(0, 40);

  const gridCols = [
    ...new Set(
      [...text.matchAll(GRID_COL_RE)].map((m) => m[1]!.toLowerCase()),
    ),
  ];

  const hasSentEmailToolbar = toolbarSample.some((l) =>
    /all sent email|email type|email address|attachment/i.test(l),
  );

  const envelopeRecognized =
    /PSSNEL/i.test(text) ||
    gridCols.length > 0 ||
    /"GRIDRESULT"|"pageData"/i.test(text) ||
    fieldNamesSample.includes('emailtype');

  return {
    hdrBytes,
    fieldNamesSample,
    toolbarSample,
    gridCols,
    hasSentEmailToolbar,
    envelopeRecognized,
  };
}
