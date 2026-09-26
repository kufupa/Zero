import type {
  ExistingDocumentListResult,
  ExistingDocumentReadResult,
} from '../../../../server-pilot/src/mail/artifacts/existing-document-contracts';
import AdminDashboardPage from '../../../app/(routes)/settings/admin-dashboard/page';
import { setMailCacheScope } from '../../../lib/mail/mail-cache-scope';
import { QueryProvider } from '../../../providers/query-provider';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';
import U6DraftSafetyPage from './u6-draft-safety';
import { BrowserRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import React from 'react';
import './fixture.css';

setMailCacheScope({ userId: 'fixture-viewer', activeTransportId: 'transport-centurion' });

const DOCUMENT_SCOPE = 'scope:fixture-documents';

function procedureJson<T>(payload: unknown): T {
  if (!Array.isArray(payload) || payload.length !== 1)
    throw new Error('invalid fixture procedure response');
  const item = payload[0];
  if (!item || typeof item !== 'object' || !('result' in item)) {
    throw new Error('fixture procedure response is missing result');
  }
  const result = item.result;
  if (!result || typeof result !== 'object' || !('data' in result)) {
    throw new Error('fixture procedure response is missing data');
  }
  const data = result.data;
  if (!data || typeof data !== 'object' || !('json' in data)) {
    throw new Error('fixture procedure response is missing json');
  }
  return data.json as T;
}

async function callDocumentProcedure<T>(path: string, input: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ json: input }]),
  });
  const payload = (await response.json()) as unknown;
  return procedureJson<T>(payload);
}

function documentLabel(
  document: NonNullable<ExistingDocumentListResult['data']>['documents'][number],
): string {
  if (document.displayName === 'fixture-authorized-invoice.txt')
    return 'Authorized fixture invoice';
  if (document.displayName === 'fixture-identity-review.txt') return 'Identity review document';
  return 'PMS metadata-only document';
}

function mergeDocumentListResults(
  results: ExistingDocumentListResult[],
): ExistingDocumentListResult {
  const withData = results.filter(
    (
      result,
    ): result is ExistingDocumentListResult & {
      data: NonNullable<ExistingDocumentListResult['data']>;
    } => result.data !== null,
  );
  if (withData.length === 0) return results[0];
  return {
    status: results.every((result) => result.status === 'ok') ? 'ok' : 'manual_required',
    data: {
      documents: withData.flatMap((result) => result.data.documents),
      page: {
        returnedCount: withData.reduce(
          (count, result) => count + result.data.page.returnedCount,
          0,
        ),
        hasMore: withData.some((result) => result.data.page.hasMore),
        nextCursor: null,
      },
      sourceOutcomes: withData.flatMap((result) => result.data.sourceOutcomes),
    },
    blocker: results.find((result) => result.blocker !== null)?.blocker ?? null,
    issues: results.flatMap((result) => result.issues),
  };
}

function DocumentsPilotPage() {
  const [listResult, setListResult] = React.useState<ExistingDocumentListResult | null>(null);
  const [selectedRef, setSelectedRef] = React.useState<string>('');
  const [readResult, setReadResult] = React.useState<ExistingDocumentReadResult | null>(null);
  const [sourceStatus, setSourceStatus] = React.useState<string | null>(null);

  const documents = listResult?.data?.documents ?? [];
  const selected =
    documents.find((document) => document.documentRef === selectedRef) ?? documents[0];

  React.useEffect(() => {
    let active = true;
    void Promise.all([
      callDocumentProcedure<ExistingDocumentListResult>('/api/trpc/documents.listExisting', {
        scopeRef: DOCUMENT_SCOPE,
        source: 'mail_attachment',
        kinds: ['tax_invoice'],
        limit: 20,
      }),
      callDocumentProcedure<ExistingDocumentListResult>('/api/trpc/documents.listExisting', {
        scopeRef: DOCUMENT_SCOPE,
        source: 'hms_finalized_document',
        kinds: ['tax_invoice'],
        limit: 20,
      }),
    ]).then((results) => {
      if (!active) return;
      const result = mergeDocumentListResults(results);
      setListResult(result);
      setSelectedRef(result.data?.documents[0]?.documentRef ?? '');
    });
    return () => {
      active = false;
    };
  }, []);

  async function readDocument(format: 'text' | 'artifact') {
    if (!selected?.documentRef) return;
    setSourceStatus(null);
    const result = await callDocumentProcedure<ExistingDocumentReadResult>(
      '/api/trpc/documents.readExisting',
      {
        documentRef: selected.documentRef,
        format,
      },
    );
    setReadResult(result);
  }

  async function checkUnavailableSource() {
    const result = await callDocumentProcedure<ExistingDocumentListResult>(
      '/api/trpc/documents.listExisting',
      {
        scopeRef: DOCUMENT_SCOPE,
        source: 'hms_finalized_document',
        kinds: ['tax_invoice'],
        limit: 20,
      },
    );
    const outcome = result.data?.sourceOutcomes[0];
    const blocker = result.blocker ?? outcome?.issues[0]?.code ?? 'SOURCE_UNAVAILABLE';
    const retrievable = result.data?.documents[0]?.retrievable ?? false;
    setSourceStatus(
      `PMS finalized document source unavailable: ${blocker}; retrievable: ${String(retrievable)}`,
    );
  }

  async function checkDeniedScope() {
    const result = await callDocumentProcedure<ExistingDocumentListResult>(
      '/api/trpc/documents.listExisting',
      {
        scopeRef: 'scope:fixture-denied',
        source: 'mail_attachment',
        kinds: ['tax_invoice'],
        limit: 20,
      },
    );
    setSourceStatus(`Access denied: ${result.blocker ?? 'SCOPE_DENIED'}`);
  }

  return (
    <main className="bg-background text-foreground min-h-screen p-6">
      <div className="mx-auto grid max-w-4xl gap-6">
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold">Existing documents</h1>
          <p className="text-muted-foreground text-sm">
            Synthetic fixture seam: documents_list_existing → documents_read_existing. External
            storage and PMS bytes are substituted; source, opaque ref, hash and validation remain
            contract-driven.
          </p>
        </header>

        <section
          aria-labelledby="document-selection-heading"
          className="grid gap-4 rounded-lg border p-4"
        >
          <h2 id="document-selection-heading" className="text-lg font-medium">
            Select a document
          </h2>
          <label className="grid gap-2 text-sm font-medium" htmlFor="document-select">
            Document
            <select
              id="document-select"
              aria-label="Document"
              className="bg-background min-h-[44px] rounded-md border px-3 text-sm"
              value={selectedRef}
              onChange={(event) => {
                setSelectedRef(event.target.value);
                setReadResult(null);
                setSourceStatus(null);
              }}
            >
              {documents.map((document) => (
                <option key={document.documentRef} value={document.documentRef ?? ''}>
                  {documentLabel(document)}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium">Source</dt>
                <dd>Source: {selected.source}</dd>
              </div>
              <div>
                <dt className="font-medium">Reference</dt>
                <dd>{selected.documentRef}</dd>
              </div>
              <div>
                <dt className="font-medium">Retrieval</dt>
                <dd>retrievable: {String(selected.retrievable)}</dd>
              </div>
              <div>
                <dt className="font-medium">Retrieval blocker</dt>
                <dd>{selected.retrievalBlocker ?? 'none'}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">Loading document metadata…</p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className="min-h-[44px] rounded-md border px-4"
              type="button"
              onClick={() => void readDocument('text')}
            >
              Read text
            </button>
            <button
              className="min-h-[44px] rounded-md border px-4"
              type="button"
              onClick={() => void readDocument('artifact')}
            >
              Request artifact
            </button>
            <button
              className="min-h-[44px] rounded-md border px-4"
              type="button"
              onClick={() => void checkUnavailableSource()}
            >
              Check unavailable PMS source
            </button>
            <button
              className="min-h-[44px] rounded-md border px-4"
              type="button"
              onClick={() => void checkDeniedScope()}
            >
              Check denied scope
            </button>
          </div>
          <p className="text-muted-foreground text-sm">Artifact mode: unsupported</p>
        </section>

        {sourceStatus ? (
          <p role="status" className="rounded-md border border-dashed p-4 text-sm">
            {sourceStatus}
          </p>
        ) : null}

        {readResult ? (
          <section aria-label="Document result" className="grid gap-3 rounded-lg border p-4">
            <h2 className="text-lg font-medium">Read result</h2>
            <p data-testid="document-status">{readResult.status}</p>
            {readResult.status === 'ok' ? (
              <p>Validated text result</p>
            ) : (
              <p>Manual review required</p>
            )}
            {readResult.data ? (
              <>
                <div data-testid="document-validation" className="grid gap-1 text-sm">
                  <span>identity: {readResult.data.validation.identity}</span>
                  <span>stayDates: {readResult.data.validation.stayDates}</span>
                  <span>payer: {readResult.data.validation.payer}</span>
                  <span>kind: {readResult.data.validation.kind}</span>
                  <span>version: {readResult.data.validation.version}</span>
                  <span>priceVisibility: {readResult.data.validation.priceVisibility}</span>
                </div>
                <p>artifactRef: {readResult.data.artifactRef ?? 'null'}</p>
                {readResult.data.text ? (
                  <pre className="bg-muted whitespace-pre-wrap rounded-md p-3 text-sm">
                    {readResult.data.text}
                  </pre>
                ) : null}
                {readResult.status === 'manual_required' ? (
                  <p>Not validated, downloadable, or sendable</p>
                ) : null}
              </>
            ) : null}
            {readResult.blocker ? <p>{readResult.blocker}</p> : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('fixture root is missing');

const isDocumentsFixture =
  new URL(window.location.href).searchParams.get('fixture') === 'documents';
const isU6DraftSafetyFixture =
  new URL(window.location.href).searchParams.get('fixture') === 'u6-draft-safety';

createRoot(root).render(
  isU6DraftSafetyFixture ? (
    <BrowserRouter>
      <NuqsAdapter>
        <QueryProvider>
          <U6DraftSafetyPage />
        </QueryProvider>
      </NuqsAdapter>
    </BrowserRouter>
  ) : isDocumentsFixture ? (
    <BrowserRouter>
      <DocumentsPilotPage />
    </BrowserRouter>
  ) : (
    <BrowserRouter>
      <QueryProvider>
        <AdminDashboardPage />
      </QueryProvider>
    </BrowserRouter>
  ),
);
