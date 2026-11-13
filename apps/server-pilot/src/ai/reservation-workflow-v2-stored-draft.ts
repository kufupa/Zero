/** Upgrade only persisted drafts and revision snapshots before validating them. */
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const contactField = (value: unknown) => typeof value === 'string' && value.includes('@') ? 'bookerEmail' : 'bookerMobile';

function canonicalPath(path: string, contact?: unknown): string {
  return path.replace(/\/parties\/company(?=\/|$)/g, '/parties/organization')
    .replace(/\/parties\/agency(?=\/|$)/g, '/parties/bookingAgency')
    .replace(/(\/extraction\/requests\/[^/]+\/parties\/\d+)\/agency(?=\/|$)/g, '$1/bookingAgency')
    .replace(/\/body\/party\/agency(?=\/|$)/g, '/body/party/bookingAgency')
    .replace(/\/groups\/([^/]+)\/board(?=\/|$)/g, '/groups/$1/requestedMealPlan')
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
  if (/\/groups\/[^/]+$/.test(path)) {
    if (!Object.hasOwn(row, 'requestedMealPlan') && (Object.hasOwn(row, 'mealPlan') || Object.hasOwn(row, 'board'))) {
      row.requestedMealPlan = Object.hasOwn(row, 'mealPlan') ? row.mealPlan : row.board;
      row.mealPlan = null;
    }
    delete row.board;
  }
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
  const groupAliases = new Map<string, string>();
  const legacyGroups = new Map<string, boolean>();
  const quotePrefixes = new Set<string>();
  const quotePrefixAliases = new Map<string, string[]>();
  const proposal = object(root.proposal), content = object(proposal?.content);
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, requestIndex) => {
    const request = object(entry), body = object(request?.body);
    if (request?.kind !== 'quote' || !Array.isArray(body?.groups)) return;
    const id = request.id;
    const prefixes = [`/proposal/content/requests/${requestIndex}`, `/requests/${requestIndex}`,
      ...(typeof id === 'string' ? [`/proposal/content/requests/${encodeURIComponent(id)}`, `/requests/${id}`] : [])];
    const groupPrefixes = prefixes.map(prefix => `${prefix}/body/groups/`);
    groupPrefixes.forEach(prefix => { quotePrefixes.add(prefix); quotePrefixAliases.set(prefix, groupPrefixes); });
    body.groups.forEach((entry, index) => {
      const group = object(entry);
      if (!group) return;
      const key = `${requestIndex}/${index}`;
      const ids = [String(index), ...(typeof group.id === 'string' && !/^\d+$/.test(group.id) ? [encodeURIComponent(group.id)] : [])];
      for (const prefix of prefixes) for (const groupId of ids) groupAliases.set(`${prefix}/body/groups/${groupId}`, key);
      legacyGroups.set(key, !Object.hasOwn(group, 'requestedMealPlan'));
    });
  });
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
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, index) => {
    const id = object(entry)?.id;
    for (const prefix of [`/proposal/content/requests/${index}`, `/requests/${index}`,
      ...(typeof id === 'string' ? [`/proposal/content/requests/${encodeURIComponent(id)}`, `/requests/${id}`] : [])])
      collect(entry, prefix);
  });
  const classifyOverride = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, index) => classifyOverride(entry, `${path}/${index}`)); return; }
    const row = object(value);
    if (!row) return;
    const match = path.match(/^(.*\/body\/groups\/)([^/]+)$/);
    const prefix = match?.[1];
    if (match && prefix && quotePrefixes.has(prefix) &&
        (Object.hasOwn(row, 'requestedMealPlan') || Object.hasOwn(row, 'mealPlan') || Object.hasOwn(row, 'board'))) {
      const key = groupAliases.get(path) ?? path;
      const ids = [match[2]!, ...(typeof row.id === 'string' && !/^\d+$/.test(row.id) ? [encodeURIComponent(row.id)] : [])];
      for (const alias of quotePrefixAliases.get(prefix) ?? []) for (const id of ids) groupAliases.set(`${alias}${id}`, key);
      legacyGroups.set(key, !Object.hasOwn(row, 'requestedMealPlan'));
    }
    for (const [key, entry] of Object.entries(row)) classifyOverride(entry, `${path}/${key}`);
  };
  const overrides = object(root.fieldOverrides);
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry);
    if (override?.state === 'set') classifyOverride(override.value, path);
  }
  const resolvePath = (path: string, value?: unknown): string => {
    const group = path.match(/^(.*\/groups\/[^/]+)\/mealPlan(?=\/|$)/);
    const groupPath = group?.[1];
    const groupKey = groupPath && (groupAliases.get(groupPath) ?? groupPath);
    const isQuote = groupPath && [...quotePrefixes].some(prefix => groupPath.startsWith(prefix));
    const oldMealPlan = isQuote && groupKey && (legacyGroups.get(groupKey) ?? true);
    const renamed = oldMealPlan ? path.replace(/\/mealPlan(?=\/|$)/, '/requestedMealPlan') : path;
    const legacy = renamed.match(/^.*\/bookerContact(?=\/|$)/)?.[0];
    return canonicalPath(renamed, value ?? (legacy ? contacts.get(legacy) : undefined));
  };
  const extraction = object(root.extraction);
  if (Array.isArray(extraction?.requests)) for (const entry of extraction.requests) {
    const request = object(entry);
    if (!request) continue;
    rename(request, 'boardHints', 'mealPlanHints');
    if (Array.isArray(request.parties)) for (const entry of request.parties) {
      const party = object(entry);
      if (party?.role === 'agency') party.role = 'bookingAgency';
    }
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
    const entries = Object.entries(original).sort(([left], [right]) =>
      Number(/\/board(?:\/|$)/.test(left)) - Number(/\/board(?:\/|$)/.test(right)));
    for (const [path, entry] of entries) {
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
    if (criteria.workflow === 'quote' || row?.kind === 'party_candidate') {
      if (criteria.role === 'company') criteria.role = 'organization';
      if (criteria.role === 'agency') criteria.role = 'bookingAgency';
      if (result?.kind === 'company') result.kind = 'organization';
      if (result?.kind === 'agency') result.kind = 'bookingAgency';
    }
  }
  return draft;
}
