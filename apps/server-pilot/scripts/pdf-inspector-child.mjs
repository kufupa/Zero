#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PROTOCOL_OUTPUT_BYTES = 2 * 1024 * 1024;

function normalizeText(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function pageList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((page) => Number.isInteger(page) && page >= 1 && page <= MAX_PAGES);
}

function failure(reason, pageCount = null) {
  return {
    status: 'manual_required',
    reason,
    pageCount,
    markdown: null,
    pdfType: null,
    confidence: null,
    pagesNeedingOcr: [],
    pagesWithTables: [],
    pagesWithColumns: [],
    isComplexLayout: null,
    hasEncodingIssues: null,
  };
}

function classifyNativeError(error) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message).toLowerCase()
      : '';
  if (
    /pdf is encrypted|encrypted pdf|password required|requires password|invalid password/.test(
      message,
    )
  ) {
    return 'encrypted';
  }
  if (
    /malformed pdf|invalid pdf|pdf parse error|pdf syntax error|invalid xref|unexpected end of (?:file|pdf)/.test(
      message,
    )
  ) {
    return 'malformed';
  }
  return 'parser_failure';
}

function emit(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PROTOCOL_OUTPUT_BYTES) {
    process.stdout.write(JSON.stringify(failure('too_large')));
    return;
  }
  process.stdout.write(json);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) {
    emit(failure('malformed'));
    return;
  }

  let input;
  try {
    const stat = statSync(inputPath);
    if (!Number.isSafeInteger(stat.size) || stat.size > MAX_INPUT_BYTES) {
      emit(failure('too_large'));
      return;
    }
    input = readFileSync(inputPath);
  } catch {
    emit(failure('parser_failure'));
    return;
  }

  if (input.byteLength > MAX_INPUT_BYTES || input.subarray(0, 5).toString('ascii') !== '%PDF-') {
    emit(failure(input.byteLength > MAX_INPUT_BYTES ? 'too_large' : 'malformed'));
    return;
  }

  let inspector;
  try {
    // Sole native import site. Parent remains native-module free.
    inspector = await import('@firecrawl/pdf-inspector');
  } catch {
    emit(failure('parser_failure'));
    return;
  }

  let parsed;
  try {
    parsed = inspector.processPdf(input);
  } catch (error) {
    emit(failure(classifyNativeError(error)));
    return;
  }

  const pageCount =
    Number.isSafeInteger(parsed?.pageCount) && parsed.pageCount >= 1 ? parsed.pageCount : null;
  if (pageCount === null) {
    emit(failure('malformed'));
    return;
  }
  if (pageCount > MAX_PAGES) {
    emit(failure('too_many_pages', pageCount));
    return;
  }

  const markdown = typeof parsed.markdown === 'string' ? normalizeText(parsed.markdown) : '';
  if (Buffer.byteLength(markdown, 'utf8') > MAX_OUTPUT_BYTES) {
    emit(failure('too_large', pageCount));
    return;
  }
  emit({
    status: markdown ? 'ok' : 'manual_required',
    reason: markdown ? 'text' : 'no_embedded_text',
    pageCount,
    markdown: markdown || null,
    pdfType:
      parsed.pdfType === 'TextBased' ||
      parsed.pdfType === 'Scanned' ||
      parsed.pdfType === 'ImageBased' ||
      parsed.pdfType === 'Mixed'
        ? parsed.pdfType
        : null,
    confidence:
      typeof parsed.confidence === 'number' &&
      Number.isFinite(parsed.confidence) &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null,
    pagesNeedingOcr: pageList(parsed.pagesNeedingOcr),
    pagesWithTables: pageList(parsed.pagesWithTables),
    pagesWithColumns: pageList(parsed.pagesWithColumns),
    isComplexLayout: typeof parsed.isComplexLayout === 'boolean' ? parsed.isComplexLayout : null,
    hasEncodingIssues:
      typeof parsed.hasEncodingIssues === 'boolean' ? parsed.hasEncodingIssues : null,
  });
}

await main();
