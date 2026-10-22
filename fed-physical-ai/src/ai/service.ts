import { randomUUID } from 'node:crypto';
import { authorize, HttpError, type Principal } from '../platform/contracts.js';
import type { Controller } from '../platform/controller.js';
import { digest } from '../platform/document.js';
import { RateLimiter } from '../platform/observability.js';
import { advisorContext } from './context.js';
import { planRequestSchema, type AdviceResult } from './contracts.js';
import type { Advisor } from './bedrock.js';

export class PlanningService {
  private rate = new RateLimiter(6);
  private active = 0;
  constructor(
    private controller: Controller,
    private advisor: Advisor,
  ) {}
  status() {
    return {
      enabled: this.advisor.settings.enabled,
      provider: 'amazon-bedrock',
      modelId: this.advisor.settings.modelId,
      region: this.advisor.settings.region,
      execution: 'human-approved-controller-only',
    };
  }
  async plan(input: unknown, actor: Principal, requestId = randomUUID()): Promise<AdviceResult> {
    authorize(actor, 'transfer');
    const { prompt } = planRequestSchema.parse(input);
    if (!this.advisor.settings.enabled)
      throw new HttpError(503, 'Bedrock planning is not enabled on this server.');
    if (!this.controller.ready) throw new HttpError(503, 'The controller is not ready.');
    if (!this.rate.allow(actor.subject) || this.active >= 2)
      throw new HttpError(429, 'Planning capacity reached. Retry later.');
    this.active++;
    const promptDigest = digest(prompt);
    try {
      const context = advisorContext(
        await this.controller.state(),
        this.controller.config,
        'production',
      );
      await this.controller.store.transact(() => ({
        value: undefined,
        audit: [
          {
            actor: actor.subject,
            action: 'ai.requested',
            requestId,
            details: {
              promptDigest,
              contextDigest: digest(context),
              modelId: this.advisor.settings.modelId,
            },
          },
        ],
      }));
      const result = await this.advisor.plan(prompt, context);
      await this.controller.store.transact(() => ({
        value: undefined,
        audit: [
          {
            actor: actor.subject,
            action: 'ai.recommended',
            requestId,
            details: {
              planId: result.id,
              modelId: result.modelId,
              contextDigest: result.contextDigest,
              recommendations: result.recommendations,
              usage: result.usage,
              resultDigest: digest(result),
            },
          },
        ],
      }));
      return result;
    } catch (error) {
      await this.controller.store
        .transact(() => ({
          value: undefined,
          audit: [
            { actor: actor.subject, action: 'ai.failed', requestId, details: { promptDigest } },
          ],
        }))
        .catch(() => undefined);
      throw error;
    } finally {
      this.active--;
    }
  }
}
