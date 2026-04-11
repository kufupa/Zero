import { getDemoSettings, listDemoDrafts, listDemoTemplates } from './local-store';
import { canonicalizeEmail, parseRecipientToken, splitRecipientField, type ParsedRecipientToken } from './recipient-parsing';

export type RecipientSuggestion = {
  email: string;
  name?: string | null;
  displayText: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_LIMIT = 10;

const addRecipient = (
  values: Map<string, RecipientSuggestion>,
  suggestion: ParsedRecipientToken | null,
) => {
  if (!suggestion?.email) return;
  const normalizedEmail = canonicalizeEmail(suggestion.email);
  if (!EMAIL_REGEX.test(normalizedEmail)) return;

  if (values.has(normalizedEmail)) return;
  values.set(normalizedEmail, {
    email: normalizedEmail,
    name: suggestion.name,
    displayText: suggestion.name ? `${suggestion.name} <${normalizedEmail}>` : normalizedEmail,
  });
};

const collectDemoRecipientSuggestions = (): Map<string, RecipientSuggestion> => {
  const suggestions = new Map<string, RecipientSuggestion>();
  const settings = getDemoSettings();

  addRecipient(suggestions, { email: settings.defaultEmailAlias, name: 'Me' });
  for (const trusted of settings.trustedSenders ?? []) {
    addRecipient(suggestions, { email: trusted, name: undefined });
  }

  for (const draft of listDemoDrafts()) {
    for (const token of splitRecipientField(draft.to)) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
    for (const token of splitRecipientField(draft.cc)) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
    for (const token of splitRecipientField(draft.bcc)) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
  }

  for (const template of listDemoTemplates()) {
    for (const token of template.to ?? []) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
    for (const token of template.cc ?? []) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
    for (const token of template.bcc ?? []) {
      addRecipient(suggestions, parseRecipientToken(token));
    }
  }

  return suggestions;
};

export const listDemoRecipientSuggestions = (query = '', limit = DEFAULT_LIMIT): RecipientSuggestion[] => {
  const normalizedQuery = query.trim().toLowerCase();
  const suggestionValues = Array.from(collectDemoRecipientSuggestions().values());

  const filteredSuggestions = normalizedQuery
    ? suggestionValues.filter((suggestion) =>
        suggestion.email.toLowerCase().includes(normalizedQuery) ||
        (suggestion.name ?? '').toLowerCase().includes(normalizedQuery),
      )
    : suggestionValues;

  return filteredSuggestions
    .sort((a, b) => a.email.localeCompare(b.email))
    .slice(0, limit);
};
