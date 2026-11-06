import {
  allows,
  chooseModel,
  type EmbeddingModel,
  isFakeModel,
  type ModelChoice,
  type ModelRefusal,
  type ModelRegistry,
  modelRegistry,
} from '@hykr/agents';
import {
  type ModelKind,
  ModelPolicy,
  ModelsCapability,
  type ModelsOverview,
  type ModelUse,
  type Principal,
} from '@hykr/contracts';
import { registerOp, TenantConfigService } from '@hykr/core';
import { can } from '@hykr/policy';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import type { Subscription } from 'rxjs';
import type { TurnInfo, TurnRefusal } from '../../hooks.js';
import { type ModelGate, setModelGate } from '../../modules/chat/turn-hooks.js';
import { ModelPolicyChanged, SET_MODEL_POLICY, setModelPolicy } from './set-policy.js';

const log = new Logger('Models');

/** No model may be used for this: the refusal says why. */
export class ModelRefused extends Error {
  constructor(readonly refusal: ModelRefusal) {
    super(refusal.reason);
    this.name = 'ModelRefused';
  }
}

const refusal = (rule: ModelRefusal['rule'], reason: string): ModelRefusal => ({
  ok: false,
  rule,
  reason,
  status: 503,
});

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const useOf = (c: ModelChoice | ModelRefusal): ModelUse =>
  c.ok ? { ref: c.ref } : { refused: { rule: c.rule, reason: c.reason } };

/** The owner registerOp keeps, so a second start in one process registers nothing new. */
const OWNER = { feature: 'models' };

/**
 * Each business's model policy over the deployment's registry. It chooses every assistant
 * turn's model (it is ChatService's model gate) and every embedding model, and fails closed:
 * an unknown model, one the business does not allow, one outside its regions or settings that do
 * not parse are refused, never replaced by another.
 */
@Injectable()
export class ModelPolicyService implements ModelGate, OnModuleInit, OnModuleDestroy {
  private subscription?: Subscription;

  constructor(
    private readonly tenants: TenantConfigService,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** Malformed MODEL_PROVIDERS stops the start here, with every problem listed. */
  onModuleInit() {
    const registry = modelRegistry();
    for (const problem of registry.problems) log.warn(problem);
    const refs = registry.models.map((m) => m.ref).join(', ') || 'none';
    log.log(`Models: ${refs}; default chat model: ${registry.defaults.chat ?? 'none'}`);
    registerOp(SET_MODEL_POLICY, setModelPolicy, OWNER);
    setModelGate(this);
    this.subscription = this.events.subscribe((event) => {
      if (event instanceof ModelPolicyChanged) this.tenants.invalidate(event.tenantId);
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
    setModelGate(undefined);
  }

  /** The business's policy. No business: the defaults (the deployment's default models only). */
  async policyOf(tenantId: string | null | undefined): Promise<ModelPolicy> {
    if (!tenantId) return ModelPolicy.parse(undefined);
    return (await this.tenants.get(tenantId)).settings.models;
  }

  /** The model for one use, or why none: settings or a registry that fail are a refusal. */
  private async pick(
    tenantId: string | null | undefined,
    kind: ModelKind,
    requested?: string,
  ): Promise<ModelChoice | ModelRefusal> {
    let policy: ModelPolicy;
    try {
      policy = await this.policyOf(tenantId);
    } catch (e) {
      log.warn(`The settings of business ${tenantId} do not parse: ${reasonOf(e)}`);
      return refusal('model_policy_invalid', "This business's model policy is not valid");
    }
    let registry: ModelRegistry;
    try {
      registry = modelRegistry();
    } catch (e) {
      return refusal('model_not_configured', reasonOf(e));
    }
    return chooseModel(registry, policy, { kind, requested });
  }

  /** The chat model for one of this business's turns (`requested`: a turn hook's). */
  chatFor(tenantId: string | null | undefined, requested?: string) {
    return this.pick(tenantId, 'chat', requested);
  }

  /**
   * The embedding model this business uses (memory recall), as an AI SDK embedding model:
   * the business's own, else the deployment's default. Throws ModelRefused.
   */
  async embeddingFor(
    tenantId: string | null | undefined,
  ): Promise<{ ref: string; model: EmbeddingModel }> {
    const choice = await this.pick(tenantId, 'embedding');
    if (!choice.ok) throw new ModelRefused(choice);
    return { ref: choice.ref, model: modelRegistry().embeddingModel(choice.ref) };
  }

  /**
   * What `GET /api/models` shows a member: the business's policy, the models a turn and an
   * embedding would use (or why none), and every model of the deployment with whether this
   * business may use it. Prices only for people with `models.manage`.
   */
  async overview(p: Principal): Promise<ModelsOverview> {
    let policy: ModelPolicy;
    try {
      policy = await this.policyOf(p.tenantId);
    } catch {
      throw new ServiceUnavailableException({
        error: 'model_policy_invalid',
        reason: "This business's model policy is not valid",
      });
    }
    const registry = modelRegistry();
    const prices = can(p, ModelsCapability);
    const offers = (kind: ModelKind) => registry.models.some((m) => m.kind === kind);
    return {
      policy,
      chat: useOf(chooseModel(registry, policy, { kind: 'chat' })),
      embedding: offers('embedding')
        ? useOf(chooseModel(registry, policy, { kind: 'embedding' }))
        : null,
      models: registry.models.map((m) => ({
        ref: m.ref,
        kind: m.kind,
        ...(m.label ? { label: m.label } : {}),
        ...(m.region ? { region: m.region } : {}),
        allowed: allows(registry, policy, m),
        ...(prices && m.price ? { price: m.price } : {}),
      })),
    };
  }

  /* ── The model gate (ChatService's gateTurn) ─────────────────────────────── */

  /** Fake mode always runs; otherwise the deployment's default chat model must be configured. */
  ready(): TurnRefusal | null {
    if (isFakeModel()) return null;
    let registry: ModelRegistry;
    try {
      registry = modelRegistry();
    } catch (e) {
      return { rule: 'model_not_configured', reason: reasonOf(e), status: 503 };
    }
    const fallback = registry.defaults.chat;
    if (!fallback)
      return {
        rule: 'model_not_configured',
        reason:
          'Set MODEL_PROVIDERS (or OPENROUTER_API_KEY in development) in .env to use the assistant',
        status: 503,
      };
    if (registry.get(fallback)?.kind !== 'chat')
      return {
        rule: 'model_not_configured',
        reason: `The default chat model ${fallback} is not configured: list it in MODEL_PROVIDERS (or set OPENROUTER_API_KEY in development)`,
        status: 503,
      };
    return null;
  }

  async choose(turn: TurnInfo, requested?: string) {
    const choice = await this.chatFor(turn.principal.tenantId, requested);
    if (choice.ok) return { ref: choice.ref };
    return { refuse: { rule: choice.rule, reason: choice.reason, status: choice.status } };
  }
}
