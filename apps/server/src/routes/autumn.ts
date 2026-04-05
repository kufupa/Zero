import { Autumn, fetchPricingTable } from 'autumn-js';
import type { HonoContext } from '../ctx';
import { env } from '../env';
import { Hono } from 'hono';

const sanitizeCustomerBody = (body: any) => {
  let bodyCopy = { ...body };
  delete bodyCopy.id;
  delete bodyCopy.name;
  delete bodyCopy.email;
  return bodyCopy;
};

type AutumnContext = {
  Variables: {
    customerData: {
      customerId: string;
      customerData: {
        name: string;
        email: string;
      };
    } | null;
  };
} & HonoContext;

const autumnSecretConfigured = () => String(env.AUTUMN_SECRET_KEY ?? '').trim().length > 0;

/** Billing API without Autumn keys would 500; stub a generous customer for local dev. */
const localDevCustomerResponse = (customerData: NonNullable<AutumnContext['Variables']['customerData']>) => ({
  id: customerData.customerId,
  email: customerData.customerData.email,
  name: customerData.customerData.name,
  features: {
    'chat-messages': {
      unlimited: true,
      balance: 999_999,
      usage: 0,
      included_usage: 999_999,
      next_reset_at: null,
      interval: 'month',
    },
    connections: {
      unlimited: true,
      balance: 999_999,
      usage: 0,
      included_usage: 999_999,
      next_reset_at: null,
      interval: 'month',
    },
    'brain-activity': {
      unlimited: true,
      balance: 999_999,
      usage: 0,
      included_usage: 999_999,
      next_reset_at: null,
      interval: 'month',
    },
  },
  products: [{ id: 'pro-example', name: 'Pro (local dev)' }],
});

export const autumnApi = new Hono<AutumnContext>()
  .use('*', async (c, next) => {
    const { sessionUser } = c.var;
    c.set(
      'customerData',
      !sessionUser
        ? null
        : {
            customerId: sessionUser.id,
            customerData: {
              name: sessionUser.name,
              email: sessionUser.email,
            },
          },
    );
    if (autumnSecretConfigured()) {
      c.set('autumn', new Autumn({ secretKey: env.AUTUMN_SECRET_KEY }));
    }
    await next();
  })
  .post('/customers', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    if (!customerData) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.body(null, 204);
      }
      return c.json({ error: 'No customer ID found' }, 401);
    }

    if (!autumn && (env.NODE_ENV === 'local' || env.NODE_ENV === 'development')) {
      return c.json({
        ...localDevCustomerResponse(customerData),
        ...sanitizeCustomerBody(body),
      });
    }

    if (!autumn) {
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.customers
        .create({
          id: customerData.customerId,
          ...customerData.customerData,
          ...sanitizeCustomerBody(body),
        })
        .then((data) => data.data),
    );
  })
  .post('/attach', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    const sanitizedBody = sanitizeCustomerBody(body);
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({});
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn
        .attach({
          ...sanitizedBody,
          customer_id: customerData.customerId,
          customer_data: customerData.customerData,
        })
        .then((data) => data.data),
    );
  })
  .post('/cancel', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    const sanitizedBody = sanitizeCustomerBody(body);
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({});
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn
        .cancel({
          ...sanitizedBody,
          customer_id: customerData.customerId,
        })
        .then((data) => data.data),
    );
  })
  .post('/check', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    const sanitizedBody = sanitizeCustomerBody(body);
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ allowed: true });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn
        .check({
          ...sanitizedBody,
          customer_id: customerData.customerId,
          customer_data: customerData.customerData,
        })
        .then((data) => data.data),
    );
  })
  .post('/track', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    const sanitizedBody = sanitizeCustomerBody(body);
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ success: true });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn
        .track({
          ...sanitizedBody,
          customer_id: customerData.customerId,
          customer_data: customerData.customerData,
        })
        .then((data) => data.data),
    );
  })
  .post('/billing_portal', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ url: env.VITE_PUBLIC_APP_URL });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.customers
        .billingPortal(customerData.customerId, body)
        .then((data) => data.data),
    );
  })
  .post('/openBillingPortal', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ url: env.VITE_PUBLIC_APP_URL });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.customers
        .billingPortal(customerData.customerId, {
          ...body,
          return_url: `${env.VITE_PUBLIC_APP_URL}`,
        })
        .then((data) => data.data),
    );
  })
  .post('/entities', async (c) => {
    const { autumn, customerData } = c.var;
    const body = await c.req.json();
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ id: crypto.randomUUID() });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.entities.create(customerData.customerId, body).then((data) => data.data),
    );
  })
  .get('/entities/:entityId', async (c) => {
    const { autumn, customerData } = c.var;
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    const entityId = c.req.param('entityId');
    const expand = c.req.query('expand')?.split(',') as 'invoices'[] | undefined;

    if (!entityId) {
      return c.json(
        {
          error: 'no_entity_id',
          message: 'Entity ID is required',
        },
        400,
      );
    }

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ id: entityId });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.entities
        .get(customerData.customerId, entityId, { expand })
        .then((data) => data.data),
    );
  })
  .delete('/entities/:entityId', async (c) => {
    const { autumn, customerData } = c.var;
    if (!customerData) return c.json({ error: 'No customer ID found' }, 401);

    const entityId = c.req.param('entityId');

    if (!entityId) {
      return c.json(
        {
          error: 'no_entity_id',
          message: 'Entity ID is required',
        },
        400,
      );
    }

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ ok: true });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await autumn.entities.delete(customerData.customerId, entityId).then((data) => data.data),
    );
  })
  .get('/components/pricing_table', async (c) => {
    const { autumn, customerData } = c.var;

    if (!autumn) {
      if (env.NODE_ENV === 'local' || env.NODE_ENV === 'development') {
        return c.json({ products: [] });
      }
      return c.json({ error: 'Billing (Autumn) is not configured' }, 503);
    }

    return c.json(
      await fetchPricingTable({
        instance: autumn,
        params: {
          customer_id: customerData?.customerId || undefined,
        },
      }).then((data) => data.data),
    );
  });
