import { z } from 'zod';
import { acknowledgementEnvelopeSchema, commandSchema, envelopeSchema } from './contracts.js';
import { planRequestSchema, adviceSchema } from '../ai/contracts.js';
const result = (description: string) => ({
    description,
    content: { 'application/json': { schema: { type: 'object' } } },
  }),
  security = [{ bearerAuth: [] }, { sessionCookie: [] }];
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Reserve Physical AI Operations',
    version: '2.0.0',
    description:
      'OIDC-protected operations using signed observations, durable review and acknowledged gateway execution.',
  },
  paths: {
    '/api/ai/status': {
      get: {
        summary: 'Bedrock model and planning availability',
        security,
        responses: { '200': result('Planning configuration; no credentials are exposed') },
      },
    },
    '/api/ai/plan': {
      post: {
        summary: 'Generate audited, validated recommendations',
        description:
          'Requires an operator or supervisor. Cookie sessions require matching Origin and X-CSRF-Token. No command is executed by this endpoint.',
        security,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: z.toJSONSchema(planRequestSchema) } },
        },
        responses: {
          '200': {
            description: 'Structured advice with model ID, region, context digest and token usage',
            content: { 'application/json': { schema: z.toJSONSchema(adviceSchema) } },
          },
          '403': result('Insufficient role or invalid CSRF'),
          '429': result('Planning capacity reached'),
          '502': result('Invalid or incomplete model output'),
          '503': result('Bedrock disabled, AWS credentials invalid or service unavailable'),
        },
      },
    },
    '/health/live': {
      get: { summary: 'Process liveness', responses: { '200': result('Process alive') } },
    },
    '/health/ready': {
      get: {
        summary: 'Database and controller readiness',
        responses: { '200': result('Ready'), '503': result('Unavailable') },
      },
    },
    '/api/config': {
      get: {
        summary: 'Public service identity',
        responses: { '200': result('Service version, facility and sign-in route') },
      },
    },
    '/api/session': {
      get: {
        summary: 'Authenticated principal and CSRF token',
        security,
        responses: { '200': result('Principal'), '401': result('Sign-in required') },
      },
    },
    '/api/state': {
      get: {
        summary: 'Recorded device observations, reviews and commands',
        security,
        responses: { '200': result('Current operations state'), '401': result('Unauthorized') },
      },
    },
    '/api/platform': {
      get: {
        summary: 'Registered devices, approved models, policy and audit head',
        security,
        responses: { '200': result('Operational status') },
      },
    },
    '/api/command': {
      post: {
        summary: 'Authorized operations request',
        description:
          'Requires an actor-scoped Idempotency-Key. Cookie sessions also require a matching Origin and X-CSRF-Token. Review requests use the current reviewToken; quarantine requires two distinct subjects.',
        security,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 16, maxLength: 128 },
          },
          { name: 'X-CSRF-Token', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Operation' } } },
        },
        responses: {
          '200': result('Committed request; physical completion requires gateway acknowledgement'),
          '400': result('Invalid request'),
          '401': result('Unauthorized'),
          '403': result('Insufficient role or CSRF failure'),
          '409': result('Policy, interlock, state or idempotency conflict'),
          '503': result('Controller unavailable'),
        },
      },
    },
    '/api/device/telemetry': {
      post: {
        summary: 'Signed device observation',
        security: [{ deviceSignature: [] }],
        parameters: [
          { name: 'X-Device-ID', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Observation' } } },
        },
        responses: {
          '202': result('Observation and sequence committed'),
          '401': result('Invalid signature'),
          '409': result('Stale, replayed or unapproved provenance'),
        },
      },
    },
    '/api/device/acknowledgements': {
      post: {
        summary: 'Signed asynchronous execution acknowledgement',
        security: [{ deviceSignature: [] }],
        parameters: [
          { name: 'X-Device-ID', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Acknowledgement' } },
          },
        },
        responses: {
          '202': result('Result committed'),
          '409': result('Replay or invalid command transition'),
        },
      },
    },
    '/api/audit': {
      get: {
        summary: 'Durable audit chain',
        security,
        parameters: [
          { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        ],
        responses: { '200': result('records and nextAfter') },
      },
    },
    '/metrics': {
      get: {
        summary: 'Authenticated Prometheus metrics',
        security,
        responses: {
          '200': {
            description: 'Counters and controller gauges',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-reserve_session' },
      deviceSignature: { type: 'apiKey', in: 'header', name: 'X-Device-Signature' },
    },
    schemas: {
      Operation: z.toJSONSchema(commandSchema),
      Observation: z.toJSONSchema(envelopeSchema),
      Acknowledgement: z.toJSONSchema(acknowledgementEnvelopeSchema),
    },
  },
};
