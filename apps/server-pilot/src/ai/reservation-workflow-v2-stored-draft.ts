/** Upgrade only persisted drafts and revision snapshots before validating them. */
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const contactField = (value: unknown) => typeof value === 'string' && value.includes('@') ? 'bookerEmail' : 'bookerMobile';

function canonicalPath(path: string, contact?: unknown): string {
  return path.replace(/\/parties\/company(?=\/|$)/g, '/parties/organization')
    .replace(/\/parties\/agency(?=\/|$)/g, '/parties/bookingAgency')
    .replace(/\/groups\/([^/]+)\/board(?=\/|$)/g, '/groups/$1/mealPlan')
    .replace(/\/requestedBoard(?=\/|$)/g, '/requestedMealPlan')
    .replace(/\/boardHints(?=\/|$)/g, '/mealPlanHints')
    .replace(/\/bookerContact(?=\/|$)/g, `/${contactField(contact)}`);
}

function rename(row: Record<string, unknown>, from: string, to: string): void {
  if (!Object.hasOwn(row, to) && Object.hasOwn(row, from)) row[to] = row[from];
  delete row[from];
}

function hydrateValue(value: unknown, path: string, resolvePath: (path: string) => string = canonicalPath): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => hydrateValue(entry, `${path}/${index}`, resolvePath)); return; }
  const row = object(value);
  if (!row) return;
  if (path.endsWith('/parties')) { rename(row, 'company', 'organization'); rename(row, 'agency', 'bookingAgency'); }
  if (/\/groups\/[^/]+$/.test(path)) rename(row, 'board', 'mealPlan');
  rename(row, 'requestedBoard', 'requestedMealPlan');
  if (Object.hasOwn(row, 'bookerContact')) rename(row, 'bookerContact', contactField(row.bookerContact));
  if (row.field === 'bookerContact') row.field = contactField(row.value);
  for (const [key, entry] of Object.entries(row)) {
    if (key === 'path' && typeof entry === 'string') row[key] = resolvePath(entry);
    else hydrateValue(entry, `${path}/${key}`, resolvePath);
  }
}

export function hydrateStoredReservationWorkflowV2(value: unknown): unknown {
  if (!object(value)) return value;
  const draft = structuredClone(value);
  const root = object(draft)!;
  const contacts = new Map<string, unknown>();
  const canonicalContacts = new Set<string>();
  const collect = (entry: unknown, path: string): void => {
    if (Array.isArray(entry)) { entry.forEach((row, index) => collect(row, `${path}/${index}`)); return; }
    const row = object(entry);
    if (!row) return;
    if (Object.hasOwn(row, 'bookerContact')) {
      const legacyPath = `${path}/bookerContact`;
      contacts.set(legacyPath, row.bookerContact);
      if (Object.hasOwn(row, contactField(row.bookerContact))) canonicalContacts.add(legacyPath);
    }
    for (const [key, child] of Object.entries(row)) collect(child, `${path}/${key}`);
  };
  const proposal = object(root.proposal), content = object(proposal?.content);
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, index) => {
    const id = object(entry)?.id;
    for (const prefix of [`/proposal/content/requests/${index}`, `/requests/${index}`,
      ...(typeof id === 'string' ? [`/proposal/content/requests/${encodeURIComponent(id)}`, `/requests/${id}`] : [])])
      collect(entry, prefix);
  });
  const resolvePath = (path: string, value?: unknown): string => {
    const legacy = path.match(/^.*\/bookerContact(?=\/|$)/)?.[0];
    return canonicalPath(path, value ?? (legacy ? contacts.get(legacy) : undefined));
  };
  const extraction = object(root.extraction);
  if (Array.isArray(extraction?.requests)) for (const entry of extraction.requests) {
    const request = object(entry);
    if (request) rename(request, 'boardHints', 'mealPlanHints');
  }
  hydrateValue(root.proposal, '/proposal', resolvePath);
  for (const name of ['fieldOverrides', 'staffReviews', 'fieldReviewRequirements']) {
    const original = object(root[name]);
    if (!original) continue;
    const converted: Record<string, unknown> = {};
    // Existing canonical entries take precedence, independent of insertion order.
    for (const [path, entry] of Object.entries(original)) {
      const renamed = resolvePath(path, object(entry)?.value);
      if (renamed === path) converted[path] = entry;
    }
    for (const [path, entry] of Object.entries(original)) {
      const renamed = resolvePath(path, object(entry)?.value);
      if (!Object.hasOwn(converted, renamed)) converted[renamed] = entry;
      if (name === 'fieldOverrides') {
        const override = object(entry), source = contacts.get(path);
        if (path.endsWith('/bookerContact') && typeof source === 'string' && source &&
            override?.state === 'set' && typeof override.value === 'string' && override.value &&
            contactField(source) !== contactField(override.value) && !canonicalContacts.has(path)) {
          const oldPath = canonicalPath(path, source);
          if (!Object.hasOwn(original, oldPath) && !Object.hasOwn(converted, oldPath))
            converted[oldPath] = { state: 'none', updatedAt: override.updatedAt };
        }
        hydrateValue(override?.value, renamed, resolvePath);
      }
    }
    root[name] = converted;
  }
  if (Array.isArray(root.observations)) for (const observation of root.observations) {
    const row = object(observation), criteria = object(row?.criteria), result = object(row?.result);
    if (!criteria) continue;
    for (const key of ['fieldPath', 'selectionPath']) if (typeof criteria[key] === 'string') criteria[key] = resolvePath(criteria[key]);
    if (Array.isArray(criteria.fieldPaths)) criteria.fieldPaths = criteria.fieldPaths.map(path => typeof path === 'string' ? resolvePath(path) : path);
    if (criteria.workflow === 'quote') {
      if (criteria.role === 'company') criteria.role = 'organization';
      if (criteria.role === 'agency') criteria.role = 'bookingAgency';
      if (result?.kind === 'company') result.kind = 'organization';
      if (result?.kind === 'agency') result.kind = 'bookingAgency';
    }
  }
  return draft;
}
