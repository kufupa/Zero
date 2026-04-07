import centurionJson from './centurion-threads.json' with { type: 'json' };
import { centurionCorpusFileSchema } from './centurion-corpus.schema';
import type { CenturionCorpusThread } from './centurion-corpus.schema';
import {
  centurionThreadToGetResponse,
  centurionThreadToListRow,
} from './map-to-thread-response';
import type { IGetThreadResponse, IGetThreadsResponse } from '../driver/types';

let cached: CenturionCorpusFileParsed | null = null;

type CenturionCorpusFileParsed = ReturnType<typeof centurionCorpusFileSchema.parse>;

function threadLatestTs(t: CenturionCorpusThread): number {
  return Math.max(...t.messages.map((m) => new Date(m.receivedOn).getTime()));
}

export function loadCenturionCorpus(): CenturionCorpusFileParsed {
  if (!cached) {
    cached = centurionCorpusFileSchema.parse(centurionJson);
  }
  return cached;
}

export function getCenturionDemoThread(threadId: string): IGetThreadResponse | null {
  const t = loadCenturionCorpus().threads.find((x) => x.id === threadId);
  return t ? centurionThreadToGetResponse(t) : null;
}

export function listCenturionDemoThreads(params: {
  maxResults: number;
  pageToken: string;
  q: string;
}): IGetThreadsResponse {
  const sorted = [...loadCenturionCorpus().threads].sort(
    (a, b) => threadLatestTs(b) - threadLatestTs(a),
  );
  let list = sorted.map(centurionThreadToListRow);
  const q = params.q.trim().toLowerCase();
  if (q) {
    list = list.filter((row) => {
      const full = getCenturionDemoThread(row.id);
      if (!full) return false;
      const hay = `${full.latest?.subject ?? ''} ${full.latest?.sender.email ?? ''} ${full.latest?.body ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const offset = params.pageToken ? Number.parseInt(params.pageToken, 10) || 0 : 0;
  const slice = list.slice(offset, offset + params.maxResults);
  const next =
    offset + params.maxResults < list.length ? String(offset + params.maxResults) : null;
  return { threads: slice, nextPageToken: next };
}
