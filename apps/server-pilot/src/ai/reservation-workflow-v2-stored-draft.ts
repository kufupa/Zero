/** Upgrade only persisted drafts and revision snapshots before validating them. */
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
type ContactField = 'bookerEmail' | 'bookerMobile';
const contactFields: ContactField[] = ['bookerEmail', 'bookerMobile'];

function contactParts(value: unknown): Partial<Record<ContactField, unknown>> | null {
  if (value === null || object(value)?.kind === 'none') return { bookerEmail: value, bookerMobile: value };
  if (typeof value !== 'string') return null;
  if (!value.trim()) return { bookerEmail: { kind: 'none' }, bookerMobile: { kind: 'none' } };
  const result: Partial<Record<ContactField, string>> = {};
  const components = value.split(/\s*[|;,]\s*/u);
  if (components.length > 2 || components.some(component => !component.trim())) return null;
  for (const component of components) {
    const match = /^(?:(email|mobile|phone)\s*:\s*)?(.+)$/iu.exec(component.trim());
    if (!match) return null;
    const label = match[1]?.toLowerCase(), text = match[2]!.trim();
    const email = text.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text);
    const mobile = text.length <= 120 && /^(?=.*\d)[+\d][\d ()-]*$/u.test(text);
    const field: ContactField | null = email && (!label || label === 'email') ? 'bookerEmail' :
      mobile && (!label || label === 'mobile' || label === 'phone') ? 'bookerMobile' : null;
    if (!field || Object.hasOwn(result, field)) return null;
    result[field] = text;
  }
  return result;
}

const contactField = (value: unknown): ContactField => {
  const parts = contactParts(value);
  return parts && Object.hasOwn(parts, 'bookerMobile') && !Object.hasOwn(parts, 'bookerEmail') ? 'bookerMobile' : 'bookerEmail';
};

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

function hydrateValue(value: unknown, path: string, resolvePath: (path: string) => string = canonicalPath,
  preserveContact: (path: string, value: unknown, fields: ContactField[]) => void = () => {}): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => hydrateValue(entry, `${path}/${index}`, resolvePath, preserveContact)); return; }
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
  if (Object.hasOwn(row, 'bookerContact')) {
    const legacy = row.bookerContact, parts = contactParts(legacy);
    if (parts) for (const field of contactFields) {
      if (!Object.hasOwn(row, field)) row[field] = Object.hasOwn(parts, field) ? parts[field] : { kind: 'none' };
    }
    else preserveContact(`${path}/bookerContact`, legacy, contactFields.filter(field => !Object.hasOwn(row, field)));
    delete row.bookerContact;
  }
  if (row.field === 'bookerContact') row.field = contactField(row.value);
  for (const [key, entry] of Object.entries(row)) {
    if (key === 'path' && typeof entry === 'string') row[key] = resolvePath(entry);
    else hydrateValue(entry, `${path}/${key}`, resolvePath, preserveContact);
  }
}

export function hydrateStoredReservationWorkflowV2(value: unknown): unknown {
  if (!object(value)) return value;
  const draft = structuredClone(value);
  const root = object(draft)!;
  const contacts = new Map<string, { value: unknown; canonical: Set<ContactField> }>();
  const groupAliases = new Map<string, string>();
  const legacyGroups = new Map<string, boolean>();
  const quotePrefixes = new Set<string>();
  const quotePrefixAliases = new Map<string, string[]>();
  const amendPrefixes = new Set<string>();
  const proposal = object(root.proposal), content = object(proposal?.content);
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, requestIndex) => {
    const request = object(entry), body = object(request?.body);
    const id = request?.id;
    const prefixes = [`/proposal/content/requests/${requestIndex}`, `/requests/${requestIndex}`,
      ...(typeof id === 'string' ? [`/proposal/content/requests/${encodeURIComponent(id)}`, `/requests/${id}`] : [])];
    if (request?.kind === 'amend') {
      prefixes.forEach(prefix => amendPrefixes.add(`${prefix}/body`));
      return;
    }
    if (request?.kind !== 'quote' || !Array.isArray(body?.groups)) return;
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
    if (Array.isArray(entry)) {
      entry.forEach((row, index) => {
        collect(row, `${path}/${index}`);
        const id = object(row)?.id;
        if (typeof id === 'string' && !/^\d+$/.test(id)) collect(row, `${path}/${encodeURIComponent(id)}`);
      });
      return;
    }
    const row = object(entry);
    if (!row) return;
    if (Object.hasOwn(row, 'bookerContact')) {
      const legacyPath = `${path}/bookerContact`;
      contacts.set(legacyPath, { value: row.bookerContact,
        canonical: new Set(contactFields.filter(field => Object.hasOwn(row, field))) });
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
    const result = canonicalPath(renamed, value ?? (legacy ? contacts.get(legacy)?.value : undefined));
    return legacy ? activePath(result) : result;
  };
  // Compare stable-ID and numeric paths as the same field when preserving canonical edits.
  const pathIdentity = (path: string): string => {
    const parts = path.replace(/^\/requests(?=\/)/, '/proposal/content/requests').split('/').slice(1);
    let current: unknown = root;
    return '/' + parts.map(part => {
      let key = part;
      try { key = decodeURIComponent(part); } catch { /* Keep invalid legacy paths unchanged. */ }
      if (Array.isArray(current)) {
        const index = /^\d+$/.test(key) ? Number(key) : current.findIndex(row => object(row)?.id === key);
        current = current[index];
        return index >= 0 ? String(index) : part;
      }
      current = object(current)?.[key];
      return encodeURIComponent(key);
    }).join('/');
  };
  const activePath = (path: string): string => pathIdentity(path).replace(
    /^\/proposal\/content\/requests\/(\d+)(?=\/)/, (prefix, index: string) => {
      const id = object(Array.isArray(content?.requests) ? content.requests[Number(index)] : null)?.id;
      return typeof id === 'string' ? prefix.replace(/\d+$/, encodeURIComponent(id)) : prefix;
    });
  const canonicalOverrideIdentities = new Set(Object.keys(overrides ?? {}).filter(path =>
    contactFields.some(field => path.endsWith(`/${field}`))).map(pathIdentity));
  const collectCanonicalOverrideFields = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, index) => collectCanonicalOverrideFields(entry, `${path}/${index}`)); return; }
    const row = object(value);
    if (!row) return;
    for (const [field, child] of Object.entries(row)) {
      const childPath = `${path}/${encodeURIComponent(field)}`;
      if (contactFields.includes(field as ContactField)) canonicalOverrideIdentities.add(pathIdentity(childPath));
      else collectCanonicalOverrideFields(child, childPath);
    }
  };
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry);
    if (override?.state === 'set') collectCanonicalOverrideFields(override.value, path);
  }
  const pendingUnknownContacts = new Map<string, unknown>();
  const forcedUnknownContacts = new Set<string>();
  const preserveContact = (path: string, legacy: unknown, fields: ContactField[]): void => {
    if (typeof legacy !== 'string' || !legacy) return;
    const normalizedPath = resolvePath(path);
    const claims = proposal?.sourceClaims;
    if (Array.isArray(claims) && legacy.length <= 2000 && claims.length < 1000 &&
        !claims.some(claim => object(claim)?.path === normalizedPath && object(claim)?.raw === legacy)) {
      claims.push({ path: normalizedPath, raw: legacy, sourceRefs: [] });
    }
    const issues = proposal?.issues;
    if (Array.isArray(issues) && issues.length < 1000 && !issues.some(issue =>
      object(issue)?.path === normalizedPath && object(issue)?.kind === 'legacy_booker_contact_requires_review')) {
      issues.push({ path: normalizedPath, kind: 'legacy_booker_contact_requires_review',
        explanation: 'Review the saved booker contact and enter its email and mobile separately.', evidenceRefs: [] });
    }
    const requestPath = activePath(path);
    for (const field of fields) {
      const target = requestPath.replace(/\/bookerContact$/, `/${field}`);
      if (!canonicalOverrideIdentities.has(pathIdentity(target))) pendingUnknownContacts.set(target, legacy);
    }
  };
  const amendContacts = new Map<string, Array<{ field: ContactField; index: number }>>();
  const repurposedAmendContacts = new Set<string>();
  const amendContactOps = new Map<string, unknown>();
  const hydrateAmendContacts = (changes: unknown, path: string): void => {
    if (!Array.isArray(changes)) return;
    const originalLength = changes.length;
    for (let index = 0; index < originalLength; index++) {
      const change = object(changes[index]);
      if (change?.field !== 'bookerContact') continue;
      const changePath = `${path}/${index}`, key = pathIdentity(changePath);
      const entryFor = (suffix: string) => Object.entries(overrides ?? {}).find(([candidate]) =>
        pathIdentity(candidate) === `${key}${suffix ? `/${suffix}` : ''}`)?.[1];
      const fieldOverride = object(entryFor('field'));
      const opOverride = object(entryFor('op'));
      amendContactOps.set(key, opOverride?.state === 'set' ? opOverride.value :
        !opOverride || opOverride.state === 'inherit' ? change.op : undefined);
      const rowOverride = object(entryFor(''));
      const overrideRow = rowOverride?.state === 'set' ? object(rowOverride.value) : null;
      const base = change.op === 'clear' ? { bookerEmail: null, bookerMobile: null } : contactParts(change.value);
      const canonical = new Set(changes.map(row => object(row)?.field).filter(field => contactFields.includes(field as ContactField)));
      // The legacy Amend field replaced the complete native contact, so an omitted
      // component must be cleared rather than inherited from the saved stay.
      const fields = contactFields.filter(field => !canonical.has(field));
      const repurposed = fieldOverride?.state === 'set' && fieldOverride.value !== 'bookerContact' ||
        Boolean(overrideRow && overrideRow.field !== 'bookerContact');
      if (repurposed) {
        fields.splice(0, fields.length, contactField(change.value));
        repurposedAmendContacts.add(key);
      }
      if (!fields.length && canonical.size === 0) fields.push('bookerEmail');
      if (!fields.length) {
        // Keep old indices stable without turning a redundant contact into an
        // unrelated date change. Staff can remove this blocked legacy row.
        changes[index] = { op: 'set', field: 'bookerEmail', value: false, sourceRefs: change.sourceRefs };
        pendingUnknownContacts.set(`${changePath}/value`, change.value ?? '');
        const issues = proposal?.issues;
        if (Array.isArray(issues) && issues.length < 1000) issues.push({ path: `${changePath}/value`,
          kind: 'legacy_booker_contact_requires_review', explanation: 'Remove the redundant saved booker contact change; separate contact changes already exist.',
          evidenceRefs: Array.isArray(change.sourceRefs) ? change.sourceRefs : [] });
        amendContacts.set(key, []);
        continue;
      }
      const entries: Array<{ field: ContactField; index: number }> = [];
      for (const [position, field] of fields.entries()) {
        if (position > 0 && changes.length >= 200) break;
        const target = position === 0 ? index : changes.length;
        const part = base?.[field];
        const row = base && (part == null || object(part)?.kind === 'none') ? { op: 'clear', field, sourceRefs: change.sourceRefs } :
          { op: 'set', field, value: part ?? false, sourceRefs: change.sourceRefs };
        if (position === 0) changes[index] = row; else changes.push(row);
        entries.push({ field, index: target });
      }
      amendContacts.set(key, entries);
      if (!base || entries.length < fields.length) {
        const raw = typeof change.value === 'string' ? change.value : String(change.value ?? '');
        const claims = proposal?.sourceClaims;
        if (raw && Array.isArray(claims) && raw.length <= 2000 && claims.length < 1000)
          claims.push({ path: `${changePath}/value`, raw, sourceRefs: Array.isArray(change.sourceRefs) ? change.sourceRefs : [] });
        const issues = proposal?.issues;
        if (Array.isArray(issues) && issues.length < 1000) issues.push({ path: `${changePath}/value`,
          kind: 'legacy_booker_contact_requires_review', explanation: 'Review the saved booker contact and enter its email and mobile separately.',
          evidenceRefs: Array.isArray(change.sourceRefs) ? change.sourceRefs : [] });
        pendingUnknownContacts.set(`${changePath}/value`, raw);
        if (entries.length < fields.length) forcedUnknownContacts.add(pathIdentity(`${changePath}/value`));
      }
    }
  };
  const walkAmendContacts = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if ([...amendPrefixes].some(prefix => path.startsWith(`${prefix}/`)) &&
          /\/(?:sharedChanges|perTarget\/\d+\/changes)$/.test(path)) hydrateAmendContacts(value, path);
      value.forEach((entry, index) => walkAmendContacts(entry, `${path}/${index}`));
      return;
    }
    const row = object(value);
    if (row) for (const [key, child] of Object.entries(row)) walkAmendContacts(child, `${path}/${key}`);
  };
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, index) =>
    walkAmendContacts(entry, `/proposal/content/requests/${index}`));
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry);
    if (override?.state === 'set') walkAmendContacts(override.value, path);
  }
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry);
    if (override?.state !== 'set' || override.value !== 'bookerContact' ||
        ![...amendPrefixes].some(prefix => path.startsWith(`${prefix}/`)) ||
        !/\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/field$/.test(path)) continue;
    const rowPath = path.slice(0, -'/field'.length), key = pathIdentity(rowPath);
    if (amendContacts.has(key)) continue;
    const parts = key.split('/').slice(1), index = Number(parts.pop());
    let parent: unknown = root;
    for (const part of parts) parent = Array.isArray(parent) ? parent[Number(part)] : object(parent)?.[part];
    if (!Array.isArray(parent) || !Number.isInteger(index) || index >= parent.length) continue;
    const source = object(parent[index]);
    if (!source) continue;
    const valueOverride = object(Object.entries(overrides).find(([candidate]) => pathIdentity(candidate) === `${key}/value`)?.[1]);
    const value = valueOverride?.state === 'set' ? valueOverride.value : source.value;
    const copy = [...parent];
    copy[index] = source.op === 'clear' ? { op: 'clear', field: 'bookerContact', sourceRefs: source.sourceRefs } :
      { op: 'set', field: 'bookerContact', value, sourceRefs: source.sourceRefs };
    hydrateAmendContacts(copy, rowPath.slice(0, rowPath.lastIndexOf('/')));
    parent.push(...copy.slice(parent.length));
  }
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry), row = object(override?.value);
    if (override?.state !== 'set' || row?.field !== 'bookerContact' ||
        !/\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)$/.test(path)) continue;
    const key = pathIdentity(path);
    if (!amendContacts.has(key)) {
      const parts = key.split('/').slice(1), index = Number(parts.pop());
      let parent: unknown = root;
      for (const part of parts) parent = Array.isArray(parent) ? parent[Number(part)] : object(parent)?.[part];
      if (Array.isArray(parent) && Number.isInteger(index) && index < parent.length) {
        const copy = [...parent];
        copy[index] = row;
        hydrateAmendContacts(copy, path.slice(0, path.lastIndexOf('/')));
        parent.push(...copy.slice(parent.length));
      }
    }
    const targets = amendContacts.get(key) ?? [];
    const parts = row.op === 'clear' ? { bookerEmail: null, bookerMobile: null } : contactParts(row.value);
    if (!parts && typeof row.value === 'string') {
      const claims = proposal?.sourceClaims, issues = proposal?.issues;
      if (Array.isArray(claims) && row.value.length <= 2000 && claims.length < 1000)
        claims.push({ path: `${path}/value`, raw: row.value, sourceRefs: Array.isArray(row.sourceRefs) ? row.sourceRefs : [] });
      if (Array.isArray(issues) && issues.length < 1000) issues.push({ path: `${path}/value`,
        kind: 'legacy_booker_contact_requires_review', explanation: 'Review the saved booker contact and enter its email and mobile separately.',
        evidenceRefs: Array.isArray(row.sourceRefs) ? row.sourceRefs : [] });
    }
    for (const [position, target] of targets.entries()) {
      const targetPath = path.replace(/\/\d+$/, `/${target.index}`), part = parts?.[target.field];
      const migrated = parts && (part == null || object(part)?.kind === 'none') ? { op: 'clear', field: target.field, sourceRefs: row.sourceRefs } :
        { op: 'set', field: target.field, value: part ?? false, sourceRefs: row.sourceRefs };
      if (position === 0) override.value = migrated;
      else if (!Object.keys(overrides).some(existing => pathIdentity(existing) === pathIdentity(targetPath)))
        overrides[targetPath] = { ...override, value: migrated };
      if (!parts) pendingUnknownContacts.set(`${targetPath}/value`, row.value);
    }
    if (!targets.length) {
      override.value = { op: 'set', field: 'bookerEmail', value: false, sourceRefs: row.sourceRefs };
      pendingUnknownContacts.set(`${path}/value`, row.value ?? '');
      forcedUnknownContacts.add(pathIdentity(`${path}/value`));
    }
  }
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
  const hydrateAmendMeals = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, index) => hydrateAmendMeals(entry, `${path}/${index}`)); return; }
    const row = object(value);
    if (!row) return;
    if ([...amendPrefixes].some(prefix => path.startsWith(`${prefix}/`)) &&
        /\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)$/.test(path) && row.field === 'mealPlan') {
      row.field = 'requestedMealPlan';
    }
    for (const [key, child] of Object.entries(row)) hydrateAmendMeals(child, `${path}/${key}`);
  };
  if (Array.isArray(content?.requests)) content.requests.forEach((entry, index) =>
    hydrateAmendMeals(entry, `/proposal/content/requests/${index}`));
  if (overrides) for (const [path, entry] of Object.entries(overrides)) {
    const override = object(entry);
    if (override?.state !== 'set') continue;
    const isAmend = [...amendPrefixes].some(prefix => path.startsWith(`${prefix}/`));
    if (isAmend && /\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/field$/.test(path) &&
        override.value === 'mealPlan') override.value = 'requestedMealPlan';
    hydrateAmendMeals(override.value, path);
  }
  hydrateValue(root.proposal, '/proposal', resolvePath, preserveContact);
  const containsLegacyContact = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsLegacyContact);
    const row = object(value);
    return Boolean(row && (Object.hasOwn(row, 'bookerContact') || row.field === 'bookerContact' ||
      Object.values(row).some(containsLegacyContact)));
  };
  for (const name of ['fieldOverrides', 'staffReviews', 'fieldReviewRequirements']) {
    const original = object(root[name]);
    if (!original) continue;
    const converted: Record<string, unknown> = {};
    const canonicalIdentities = new Set(Object.keys(original).filter(path =>
      contactFields.some(field => path.endsWith(`/${field}`))).map(pathIdentity));
    // Existing canonical entries take precedence, independent of insertion order.
    for (const [path, entry] of Object.entries(original).sort(([left], [right]) =>
      Number(right === activePath(right)) - Number(left === activePath(left)))) {
      if (contactFields.some(field => path.endsWith(`/${field}`))) {
        const target = activePath(path);
        if (!Object.hasOwn(converted, target)) converted[target] = entry;
        continue;
      }
      const renamed = resolvePath(path, object(entry)?.value);
      const amendPath = [...amendContacts.keys()].some(key => pathIdentity(path).startsWith(`${key}/`) && /\/(?:field|value|op)$/.test(path));
      if (renamed === path && !amendPath && !(name === 'fieldOverrides' && containsLegacyContact(object(entry)?.value)))
        converted[path] = entry;
    }
    const entries = Object.entries(original).sort(([left], [right]) =>
      Number(/\/board(?:\/|$)/.test(left)) - Number(/\/board(?:\/|$)/.test(right)));
    for (const [path, entry] of entries) {
      if (contactFields.some(field => path.endsWith(`/${field}`))) continue;
      const identity = pathIdentity(path);
      const amend = [...amendContacts.entries()].find(([key]) => identity.startsWith(`${key}/`));
      if (amend && /\/(?:field|value|op)$/.test(path)) {
        const suffix = path.slice(path.lastIndexOf('/') + 1), override = object(entry);
        const originalIndex = Number(amend[0].slice(amend[0].lastIndexOf('/') + 1));
        const replacement = (index: number, leaf = suffix) =>
          path.replace(new RegExp(`/${originalIndex}/${suffix}$`), `/${index}/${leaf}`);
        for (const target of amend[1]) {
          const targetPath = replacement(target.index);
          let mapped = entry;
          if (!repurposedAmendContacts.has(amend[0]) && name === 'fieldOverrides' && suffix === 'field' && override?.state === 'set' && override.value === 'bookerContact')
            mapped = { ...override, value: target.field };
          if (!repurposedAmendContacts.has(amend[0]) && name === 'fieldOverrides' && suffix === 'value' && override?.state === 'set') {
            const parts = contactParts(override.value), part = parts?.[target.field];
            if (!parts) {
              mapped = { ...override, state: 'unknown' };
              const raw = typeof override.value === 'string' ? override.value : String(override.value ?? '');
              const claims = proposal?.sourceClaims;
              if (raw && Array.isArray(claims) && raw.length <= 2000 && claims.length < 1000)
                claims.push({ path: targetPath, raw, sourceRefs: [] });
            } else {
              const opPath = replacement(target.index, 'op');
              const clear = part == null || object(part)?.kind === 'none';
              if (amendContactOps.get(amend[0]) === 'set' && !Object.hasOwn(original, opPath) && !Object.hasOwn(converted, opPath))
                converted[opPath] = { state: 'set', value: clear ? 'clear' : 'set', updatedAt: override.updatedAt };
              mapped = clear ? { state: 'unknown', value: override.value, updatedAt: override.updatedAt } : { ...override, value: part };
            }
          }
          if (!Object.hasOwn(converted, targetPath)) converted[targetPath] = mapped;
        }
        continue;
      }
      if (path.endsWith('/bookerContact')) {
        const source = contacts.get(path), override = object(Object.entries(overrides ?? {}).find(([candidate]) =>
          pathIdentity(candidate) === pathIdentity(path))?.[1]);
        const overrideParts = override?.state === 'set' ? contactParts(override.value) : null;
        const sourceParts = contactParts(source?.value);
        const parts = override?.state === 'set' ? overrideParts : sourceParts;
        if (name === 'staffReviews' && !parts && (!override || override.state === 'set')) continue;
        const fields = new Set<ContactField>(contactFields);
        for (const field of fields) {
          const target = activePath(path.replace(/\/bookerContact$/, `/${field}`));
          if (source?.canonical.has(field) || canonicalIdentities.has(pathIdentity(target)) ||
              canonicalOverrideIdentities.has(pathIdentity(target))) continue;
          let mapped = entry;
          if (name === 'fieldOverrides' && override?.state === 'set') {
            if (!overrideParts) {
              preserveContact(path, override.value, [field]);
              mapped = { ...override, state: 'unknown' };
            } else if (Object.hasOwn(overrideParts, field)) {
              const part = overrideParts[field];
              mapped = part === null || object(part)?.kind === 'none'
                ? { state: 'none', updatedAt: override.updatedAt } : { ...override, value: part };
            } else mapped = { state: 'none', updatedAt: override.updatedAt };
          }
          if (!Object.hasOwn(converted, target)) converted[target] = mapped;
        }
        continue;
      }
      const renamed = name === 'fieldOverrides' && containsLegacyContact(object(entry)?.value)
        ? activePath(resolvePath(path, object(entry)?.value)) : resolvePath(path, object(entry)?.value);
      if (!Object.hasOwn(converted, renamed)) converted[renamed] = entry;
      if (name === 'fieldOverrides') {
        const override = object(entry);
        hydrateValue(override?.value, renamed, resolvePath, preserveContact);
      }
    }
    root[name] = converted;
  }
  const convertedOverrides = object(root.fieldOverrides), arrivedAt = object(root.source)?.arrivedAt;
  if (convertedOverrides && typeof arrivedAt === 'string') for (const [path, raw] of pendingUnknownContacts) {
    const stablePath = activePath(path);
    if (forcedUnknownContacts.has(pathIdentity(stablePath))) {
      for (const existing of Object.keys(convertedOverrides)) if (pathIdentity(existing) === pathIdentity(stablePath)) delete convertedOverrides[existing];
      convertedOverrides[stablePath] = { state: 'unknown', value: raw, updatedAt: arrivedAt };
    } else if (!Object.keys(convertedOverrides).some(existing => pathIdentity(existing) === pathIdentity(stablePath)))
      convertedOverrides[stablePath] = { state: 'unknown', value: raw, updatedAt: arrivedAt };
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
