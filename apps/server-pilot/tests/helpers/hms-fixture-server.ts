/**
 * Synthetic HMS HTTP fixture — single source of HTML/state/requests for Task 5+.
 * No static duplicate HTML trees. Request recorder + before/after state owned here.
 * Supports legacy loopback paths and live-infor Guest Stay shape.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';

export type FixtureRecordedRequest = {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string>;
};

export type HmsFixtureScenario =
  | 'default'
  | 'wrong-tenant'
  | 'wrong-property'
  | 'reservation-not-found'
  | 'reservation-one'
  | 'malformed-dom'
  | 'timeout';

export type HmsFixtureShape = 'legacy' | 'live-infor';

export type HmsFixtureState = {
  loggedIn: boolean;
  mutationHits: number;
  beforeSnapshot: Record<string, unknown>;
  afterSnapshot: Record<string, unknown>;
};

export type HmsFixtureServer = {
  origin: string;
  port: number;
  requests: FixtureRecordedRequest[];
  state: HmsFixtureState;
  setScenario(scenario: HmsFixtureScenario): void;
  snapshot(): { before: Record<string, unknown>; after: Record<string, unknown> };
  close(): Promise<void>;
};

const TENANT = 'THECENTURION_PRD';
const PROPERTY_CODE = 'centurion';
const PROPERTY_NAME = 'Centurion Hotel';
const LIVE_PROPERTY_CODE = 'HRCEN';
const LIVE_PROPERTY_NAME = 'Centurion Hotel';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function html(body: string, title = 'HMS Fixture'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function propertyHeader(opts: {
  tenant: string;
  propertyCode: string;
  propertyName: string;
}): string {
  return `<header data-testid="property-header"
    data-tenant="${opts.tenant}"
    data-property-code="${opts.propertyCode}"
    data-property-name="${opts.propertyName}">
    <span id="tenant">${opts.tenant}</span>
    <span id="property-code">${opts.propertyCode}</span>
    <span id="property-name">${opts.propertyName}</span>
  </header>`;
}

export async function startHmsFixtureServer(
  options: { scenario?: HmsFixtureScenario; shape?: HmsFixtureShape } = {},
): Promise<HmsFixtureServer> {
  let scenario: HmsFixtureScenario = options.scenario ?? 'default';
  const shape: HmsFixtureShape = options.shape ?? 'legacy';
  const requests: FixtureRecordedRequest[] = [];
  const state: HmsFixtureState = {
    loggedIn: false,
    mutationHits: 0,
    beforeSnapshot: { reservations: ['FIXTURE-1'], inventory: { STD: 3 } },
    afterSnapshot: { reservations: ['FIXTURE-1'], inventory: { STD: 3 } },
  };

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }
    requests.push({
      method,
      path: url.pathname,
      query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
      body,
      headers,
    });

    const send = (code: number, contentType: string, payload: string) => {
      res.statusCode = code;
      res.setHeader('content-type', contentType);
      res.end(payload);
    };

    if (
      scenario === 'timeout' &&
      (url.pathname === '/login' || url.pathname === '/web/base/logindisp')
    ) {
      return;
    }

    if (
      (method === 'POST' &&
        (url.pathname === '/reservation/save' ||
          url.pathname === '/reservation/delete' ||
          url.pathname === '/forms/submit' ||
          /\/web\/base\/.*\.(save|delete)$/i.test(url.pathname))) ||
      (method === 'GET' && url.pathname === '/crs/check-availability')
    ) {
      state.mutationHits += 1;
      state.afterSnapshot = {
        ...state.afterSnapshot,
        mutated: true,
        mutationHits: state.mutationHits,
      };
      send(200, 'text/plain', 'MUTATED');
      return;
    }

    if (shape === 'live-infor') {
      if (method === 'GET' && url.pathname === '/web/base/logindisp') {
        if (scenario === 'malformed-dom') {
          send(200, 'text/html', html('<div>broken login</div>'));
          return;
        }
        send(
          200,
          'text/html',
          html(`
          <form id="login-form" action="/web/base/login" method="post">
            <input name="userid" type="text" />
            <input name="password" type="text" />
            <input name="csrftckt" type="hidden" value="fixture-csrf" />
            <input name="tenant" type="hidden" value="THECENTURION_PRD" />
            <button type="submit">Sign In</button>
          </form>`),
        );
        return;
      }

      if (method === 'POST' && url.pathname === '/web/base/login') {
        state.loggedIn = true;
        res.statusCode = 302;
        res.setHeader('location', '/web/base/COMMON?REQ_KEY=fixture-key');
        res.end();
        return;
      }

      if (method === 'GET' && url.pathname === '/web/base/COMMON') {
        const tenant = scenario === 'wrong-tenant' ? 'OTHER_TENANT' : TENANT;
        const propertyCode =
          scenario === 'wrong-property' ? 'OTHER' : LIVE_PROPERTY_CODE;
        const propertyName =
          scenario === 'wrong-property' ? 'Other Hotel' : LIVE_PROPERTY_NAME;
        send(
          200,
          'text/html',
          html(
            `${propertyHeader({ tenant, propertyCode, propertyName })}
            <nav>
              <span>Front Desk</span>
              <span>Guest Stay</span>
            </nav>`,
            `Infor HMS - ${propertyCode}`,
          ),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/web/base/OSRESV') {
        send(
          200,
          'text/html',
          html(
            `${propertyHeader({
              tenant: TENANT,
              propertyCode: LIVE_PROPERTY_CODE,
              propertyName: LIVE_PROPERTY_NAME,
            })}
            <h1>Guest Stay</h1>
            <input name="search" placeholder="Search by Name, Confirmation…" />
            <input name="ff_confirmationnumber" />
            <table data-testid="prior-grid">
              <tr data-testid="result-row" data-confirmation="STALE-OLD" data-stale-row="prior"><td>STALE-OLD</td></tr>
            </table>
            <div id="results"></div>`,
            `Infor HMS - ${LIVE_PROPERTY_CODE}`,
          ),
        );
        return;
      }

      if (method === 'POST' && url.pathname === '/web/base/OSRESS.search') {
        const oneRow = scenario === 'reservation-one';
        if (!oneRow) {
          send(
            200,
            'text/html',
            html(
              `${propertyHeader({
                tenant: TENANT,
                propertyCode: LIVE_PROPERTY_CODE,
                propertyName: LIVE_PROPERTY_NAME,
              })}
              <p data-testid="no-results">No reservations found</p>
              <table data-testid="prior-grid">
                <tr data-testid="result-row" data-confirmation="STALE-OLD" data-stale-row="prior"><td>STALE-OLD</td></tr>
              </table>`,
              `Infor HMS - ${LIVE_PROPERTY_CODE}`,
            ),
          );
          return;
        }
        send(
          200,
          'text/html',
          html(
            `${propertyHeader({
              tenant: TENANT,
              propertyCode: LIVE_PROPERTY_CODE,
              propertyName: LIVE_PROPERTY_NAME,
            })}
            <table data-testid="results">
              <tr data-testid="result-row" data-confirmation="LIVE-1" data-external="EXT-1"><td>LIVE-1</td></tr>
            </table>`,
            `Infor HMS - ${LIVE_PROPERTY_CODE}`,
          ),
        );
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/login') {
      if (scenario === 'malformed-dom') {
        send(200, 'text/html', html('<div>broken login — no form</div>'));
        return;
      }
      send(
        200,
        'text/html',
        html(`
        <form id="login-form" action="/session" method="post">
          <label>Username <input aria-label="Username" name="username" /></label>
          <label>Password <input aria-label="Password" name="password" type="password" /></label>
          <button type="submit">Sign in</button>
        </form>`),
      );
      return;
    }

    if (method === 'POST' && url.pathname === '/session') {
      state.loggedIn = true;
      res.statusCode = 302;
      res.setHeader('location', '/property');
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/property') {
      const tenant = scenario === 'wrong-tenant' ? 'OTHER_TENANT' : TENANT;
      const propertyCode =
        scenario === 'wrong-property' ? 'other-prop' : PROPERTY_CODE;
      const propertyName =
        scenario === 'wrong-property' ? 'Other Hotel' : PROPERTY_NAME;
      send(
        200,
        'text/html',
        html(
          `${propertyHeader({ tenant, propertyCode, propertyName })}
          <nav>
            <a href="/reservations">Reservations</a>
            <a href="/availability/rooms">Room Availability</a>
            <a href="/availability/rates">Display Rates</a>
            <a href="/blocked/redirect" id="bad-redirect">External</a>
            <a href="/blocked/popup" target="_blank" id="bad-popup">Popup</a>
            <a href="/blocked/download" download id="bad-download">Download</a>
          </nav>`,
        ),
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/reservations') {
      send(
        200,
        'text/html',
        html(`
        ${propertyHeader({
          tenant: TENANT,
          propertyCode: PROPERTY_CODE,
          propertyName: PROPERTY_NAME,
        })}
        <form id="reservation-search" action="/web/reservation/search" method="post">
          <input type="hidden" name="action" value="search" />
          <input type="hidden" name="tenant" value="${TENANT}" />
          <input type="hidden" name="property" value="${PROPERTY_CODE}" />
          <label>Confirmation <input name="confirmationNumber" aria-label="Confirmation" /></label>
          <label>Surname <input name="surname" aria-label="Surname" /></label>
          <button type="submit">Search</button>
        </form>
        <div id="results"></div>`),
      );
      return;
    }

    if (method === 'POST' && url.pathname === '/web/reservation/search') {
      const notFound =
        scenario === 'reservation-not-found' || scenario === 'default';
      const rows = notFound
        ? '<p data-testid="no-results">No reservations found</p>'
        : `<table data-testid="results"><tr data-confirmation="FIXTURE-1"><td>FIXTURE-1</td></tr></table>
           <a href="/web/reservation/detail?id=FIXTURE-1">Open</a>`;
      send(
        200,
        'text/html',
        html(
          `${propertyHeader({
            tenant: TENANT,
            propertyCode: PROPERTY_CODE,
            propertyName: PROPERTY_NAME,
          })}${rows}`,
        ),
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/web/reservation/detail') {
      send(
        200,
        'text/html',
        html(
          `${propertyHeader({
            tenant: TENANT,
            propertyCode: PROPERTY_CODE,
            propertyName: PROPERTY_NAME,
          })}
          <article data-testid="reservation-detail" data-confirmation="FIXTURE-1">
            <span data-status="Reserved">Reserved</span>
          </article>`,
        ),
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/availability/rooms') {
      send(
        200,
        'text/html',
        html(`
        ${propertyHeader({
          tenant: TENANT,
          propertyCode: PROPERTY_CODE,
          propertyName: PROPERTY_NAME,
        })}
        <form id="room-availability" action="/availability/rooms" method="get">
          <label>Start date <input name="startDate" aria-label="Start date" /></label>
          <input type="hidden" name="view" value="inventory" />
          <button type="submit">Search availability</button>
        </form>
        <table data-testid="inventory">
          <tr data-room-type="STD" data-available="3"><td>STD</td><td>3</td></tr>
        </table>`),
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/availability/rates') {
      send(
        200,
        'text/html',
        html(`
        ${propertyHeader({
          tenant: TENANT,
          propertyCode: PROPERTY_CODE,
          propertyName: PROPERTY_NAME,
        })}
        <form id="display-rates" action="/availability/rates" method="get">
          <label>Arrival <input name="arrivalDate" aria-label="Arrival" /></label>
          <label>Nights <input name="nights" aria-label="Nights" /></label>
          <button type="submit">Calculate rates</button>
        </form>
        <table data-testid="rates">
          <tr data-rate-plan="BAR" data-amount="1200" data-currency="ZAR">
            <td>BAR</td><td>1200</td><td>ZAR</td>
          </tr>
        </table>`),
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/blocked/redirect') {
      res.statusCode = 302;
      res.setHeader('location', 'https://evil.example/phish');
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/blocked/popup') {
      send(200, 'text/html', html('<p>popup target</p>'));
      return;
    }

    if (method === 'GET' && url.pathname === '/blocked/download') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="export.csv"');
      res.end('a,b,c\n');
      return;
    }

    send(404, 'text/plain', 'not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('fixture server failed to bind');
  }
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    port: addr.port,
    requests,
    state,
    setScenario(next) {
      scenario = next;
    },
    snapshot() {
      return {
        before: { ...state.beforeSnapshot },
        after: { ...state.afterSnapshot },
      };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

export const FIXTURE_IDS = {
  tenant: TENANT,
  propertyCode: PROPERTY_CODE,
  propertyName: PROPERTY_NAME,
  livePropertyCode: LIVE_PROPERTY_CODE,
  canaryConfirmation: 'FIXTURE-1',
  transportId: 'transport-centurion',
} as const;
