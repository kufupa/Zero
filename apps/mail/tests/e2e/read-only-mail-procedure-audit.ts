export type TrpcMailProcedureParse = {
  procedures: string[];
  hasUnclassifiedMailSurface: boolean;
};

const validMailProcedureName = /^(?:mail|drafts)\.[A-Za-z][A-Za-z0-9]*$/;
const looksLikeMailProcedure = (procedure: string) =>
  /^(?:mail|drafts)(?:[.%/]|$)/i.test(procedure);

export function trpcMailProcedureNamesFromUrl(url: string): TrpcMailProcedureParse {
  try {
    // Parse route path only. Do not inspect request payloads or query values.
    const pathname = new URL(url).pathname;
    const trpcIndex = pathname.indexOf('/trpc/');
    if (trpcIndex < 0) {
      return { procedures: [], hasUnclassifiedMailSurface: false };
    }

    const rawProcedurePath = pathname.slice(trpcIndex + '/trpc/'.length);
    const rawProcedures = rawProcedurePath.split(',');
    let procedurePath: string;
    try {
      procedurePath = decodeURIComponent(rawProcedurePath);
    } catch {
      return {
        procedures: [],
        hasUnclassifiedMailSurface: rawProcedures.some(looksLikeMailProcedure),
      };
    }

    const procedures: string[] = [];
    let hasUnclassifiedMailSurface = false;
    for (const procedure of procedurePath.split(',')) {
      if (!looksLikeMailProcedure(procedure)) continue;
      if (!validMailProcedureName.test(procedure)) {
        hasUnclassifiedMailSurface = true;
        continue;
      }
      procedures.push(procedure);
    }

    return { procedures, hasUnclassifiedMailSurface };
  } catch {
    return {
      procedures: [],
      hasUnclassifiedMailSurface:
        url.includes('/trpc/mail') || url.includes('/trpc/drafts'),
    };
  }
}
