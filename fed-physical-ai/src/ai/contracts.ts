import { z } from 'zod';
import { identifier, readingSchema } from '../platform/contracts.js';
export const BEDROCK_MODEL_ID = 'openai.gpt-oss-120b-1:0';
export const planRequestSchema = z.object({ prompt: z.string().trim().min(5).max(2000) }).strict();
export const contextSchema = z
  .object({
    source: z.enum(['production', 'simulation']),
    facilityId: identifier,
    dispatchInhibited: z.boolean(),
    devices: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum(['robot', 'processing-line', 'environment', 'inspection']),
            observedAt: z.string().datetime({ offset: true }).nullable(),
            reading: readingSchema.nullable(),
            destinations: z.array(z.string().max(100)).max(50),
            capabilities: z.array(z.string().max(40)).max(10),
          })
          .strict(),
      )
      .max(40),
    reviews: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            deviceId: identifier,
            action: z.string().max(40),
            title: z.string().max(200),
            approvals: z.number().int().min(0).max(2),
            requiredApprovals: z.number().int().min(1).max(2),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type AdvisorContext = z.infer<typeof contextSchema>;
export const recommendationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('transfer'),
      deviceId: identifier,
      destination: z.string().min(1).max(100),
      rationale: z.string().min(1).max(600),
    })
    .strict(),
  z
    .object({
      kind: z.literal('review'),
      proposalId: z.string().uuid(),
      rationale: z.string().min(1).max(600),
    })
    .strict(),
  z.object({ kind: z.literal('inhibit'), rationale: z.string().min(5).max(500) }).strict(),
]);
export const adviceSchema = z
  .object({
    summary: z.string().min(1).max(1800),
    observations: z.array(z.string().min(1).max(500)).max(8),
    recommendations: z.array(recommendationSchema).max(6),
    limitations: z.array(z.string().min(1).max(500)).max(6),
  })
  .strict();
export type Advice = z.infer<typeof adviceSchema>;
export interface AdviceResult extends Advice {
  id: string;
  modelId: string;
  region: string;
  source: AdvisorContext['source'];
  createdAt: string;
  contextDigest: string;
  usage: { inputTokens: number; outputTokens: number };
}
