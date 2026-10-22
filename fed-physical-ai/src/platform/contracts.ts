import { z } from 'zod';
export const identifier = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((value) => !['constructor', 'prototype'].includes(value), 'Reserved identifier.');
export const readingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('robot'),
      status: z.enum(['idle', 'moving', 'charging', 'fault']),
      battery: z.number().min(0).max(100),
      position: z
        .object({ x: z.number(), y: z.number(), frame: z.string().min(1).max(100) })
        .strict(),
      safetyStop: z.boolean(),
      interlockReady: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('processing-line'),
      vibration: z.number().min(0).max(100),
      temperature: z.number().min(-50).max(250),
      runState: z.enum(['running', 'stopped', 'fault']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('environment'),
      temperature: z.number().min(-50).max(100),
      humidity: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspection'),
      inspectionId: z.string().uuid(),
      bundleId: z.string().min(1).max(100),
      expectedCount: z.number().int().min(0).max(100000),
      observedCount: z.number().int().min(0).max(100000),
      confidence: z.number().min(0).max(1),
      modelId: identifier,
      modelVersion: z.string().min(1).max(100),
      artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export const envelopeSchema = z
  .object({
    deviceId: identifier,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timestamp: z.string().datetime({ offset: true }),
    reading: readingSchema,
  })
  .strict();
export const acknowledgementSchema = z
  .object({
    commandId: z.string().uuid(),
    deviceId: identifier,
    status: z.enum(['accepted', 'succeeded', 'failed', 'rejected']),
    timestamp: z.string().datetime({ offset: true }),
    detail: z.string().max(1000).optional(),
  })
  .strict();
export const acknowledgementEnvelopeSchema = z
  .object({
    deviceId: identifier,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timestamp: z.string().datetime({ offset: true }),
    acknowledgement: acknowledgementSchema,
  })
  .strict();
export const commandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('inhibit'),
      data: z.object({ reason: z.string().min(5).max(500) }).strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal('release-inhibit'),
      data: z.object({ reason: z.string().min(5).max(500) }).strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal('transfer'),
      data: z
        .object({
          deviceId: identifier,
          destination: z.string().min(1).max(100),
          reference: z.string().min(1).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal('review'),
      data: z
        .object({
          id: z.string().uuid(),
          action: z.enum(['approve', 'reject', 'refresh']),
          reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
]);
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Role = 'viewer' | 'operator' | 'supervisor' | 'admin';
export interface Principal {
  subject: string;
  name: string;
  roles: Role[];
  authentication: 'bearer' | 'session' | 'simulation';
  csrf?: string;
}
export function authorize(principal: Principal, command: string): void {
  const required: Role[] =
    command === 'review' || command === 'release-inhibit'
      ? ['supervisor', 'admin']
      : ['operator', 'supervisor', 'admin'];
  if (!principal.roles.some((r) => required.includes(r)))
    throw new HttpError(403, 'Your role does not permit this operation.');
}
