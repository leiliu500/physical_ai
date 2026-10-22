import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { digest } from '../platform/document.js';
import { HttpError } from '../platform/contracts.js';
import {
  adviceSchema,
  BEDROCK_MODEL_ID,
  contextSchema,
  planRequestSchema,
  type AdvisorContext,
  type AdviceResult,
} from './contracts.js';

export interface BedrockSettings {
  enabled: boolean;
  region: string;
  modelId: string;
  maxTokens: number;
  timeoutMs: number;
}
export function bedrockSettings(values: NodeJS.ProcessEnv = process.env): BedrockSettings {
  const input = z
    .object({
      BEDROCK_ENABLED: z.enum(['true', 'false']).default('false'),
      BEDROCK_REGION: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .default(values.AWS_REGION ?? 'us-gov-west-1'),
      BEDROCK_MODEL_ID: z.literal(BEDROCK_MODEL_ID).default(BEDROCK_MODEL_ID),
      BEDROCK_MAX_TOKENS: z.coerce.number().int().min(512).max(4096).default(2048),
      BEDROCK_TIMEOUT_MS: z.coerce.number().int().min(5000).max(60000).default(45000),
    })
    .parse(values);
  return {
    enabled: input.BEDROCK_ENABLED === 'true',
    region: input.BEDROCK_REGION,
    modelId: input.BEDROCK_MODEL_ID,
    maxTokens: input.BEDROCK_MAX_TOKENS,
    timeoutMs: input.BEDROCK_TIMEOUT_MS,
  };
}
export interface Advisor {
  readonly settings: BedrockSettings;
  plan(prompt: string, context: AdvisorContext): Promise<AdviceResult>;
}
export interface ConverseTransport {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}
const prompt = readFileSync(
  new URL('./prompts/physical-ai-operations.md', import.meta.url),
  'utf8',
).trim();
if (!prompt) throw new Error('The Physical AI system prompt must not be empty.');
const system = `${prompt}\n\n## Required JSON schema\n\n${JSON.stringify(z.toJSONSchema(adviceSchema))}`;
export class BedrockAdvisor implements Advisor {
  private transport: ConverseTransport;
  constructor(
    readonly settings: BedrockSettings,
    transport?: ConverseTransport,
  ) {
    this.transport =
      transport ?? new BedrockRuntimeClient({ region: settings.region, maxAttempts: 1 });
  }
  async plan(prompt: string, context: AdvisorContext): Promise<AdviceResult> {
    if (!this.settings.enabled)
      throw new HttpError(503, 'Bedrock planning is not enabled on this server.');
    const request = planRequestSchema.parse({ prompt }),
      snapshot = contextSchema.parse(context);
    const input: ConverseCommandInput = {
      modelId: this.settings.modelId,
      system: [{ text: system }],
      messages: [
        {
          role: 'user',
          content: [
            { text: JSON.stringify({ request: request.prompt, facilitySnapshot: snapshot }) },
          ],
        },
      ],
      inferenceConfig: { maxTokens: this.settings.maxTokens, temperature: 0.1 },
      additionalModelRequestFields: { reasoning_effort: 'low' },
    };
    let response: ConverseCommandOutput;
    try {
      response = await this.transport.send(new ConverseCommand(input), {
        abortSignal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch {
      throw new HttpError(
        503,
        'Bedrock request failed. Check AWS session validity, model access, region and bedrock:InvokeModel permission. No advice was generated.',
      );
    }
    if (response.stopReason !== 'end_turn')
      throw new HttpError(
        502,
        'Bedrock did not return a complete final answer. No actions were created.',
      );
    const text =
      response.output?.message?.content
        ?.flatMap((block) => ('text' in block && block.text ? [block.text] : []))
        .join('') ?? '';
    if (text.length > 20000)
      throw new HttpError(502, 'Bedrock response exceeded the accepted size.');
    let advice;
    try {
      advice = adviceSchema.parse(
        JSON.parse(text.replace(/^\s*```json\s*([\s\S]*?)\s*```\s*$/, '$1')),
      );
    } catch {
      throw new HttpError(
        502,
        'Bedrock returned an invalid recommendation schema. No actions were created.',
      );
    }
    for (const recommendation of advice.recommendations) {
      if (recommendation.kind === 'transfer') {
        const device = snapshot.devices.find((d) => d.id === recommendation.deviceId);
        if (
          !device ||
          device.kind !== 'robot' ||
          !device.destinations.includes(recommendation.destination) ||
          !device.capabilities.includes('transfer')
        )
          throw new HttpError(
            502,
            'Bedrock proposed an unregistered device, destination or capability.',
          );
      }
      if (
        recommendation.kind === 'review' &&
        !snapshot.reviews.some((review) => review.id === recommendation.proposalId)
      )
        throw new HttpError(
          502,
          'Bedrock proposed a review that is not pending in the supplied snapshot.',
        );
    }
    return {
      ...advice,
      id: randomUUID(),
      modelId: this.settings.modelId,
      region: this.settings.region,
      source: snapshot.source,
      createdAt: new Date().toISOString(),
      contextDigest: digest(snapshot),
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };
  }
}
