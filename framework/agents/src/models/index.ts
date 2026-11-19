// The deployment's models (MODEL_PROVIDERS, OpenRouter in development, the fake ones in fake
// mode) and a business's policy over them.
export {
  FAKE_CHAT,
  FAKE_EMBEDDING,
  FAKE_PROVIDER,
  ModelConfigError,
  type ModelEnv,
  OPENROUTER,
  type ProviderConfig,
  parseProviders,
  providersFrom,
} from './config.js';
export { embedText } from './fake-embedding.js';
export {
  allows,
  chooseModel,
  chooseVision,
  type ModelChoice,
  type ModelRefusal,
  policyProblems,
} from './policy.js';
export {
  costOf,
  type EmbeddingModel,
  hasCapability,
  type LanguageModel,
  type ModelEntry,
  type ModelRegistry,
  modelRegistry,
  type ProviderEntry,
  priceOf,
  type TokenUsage,
  UnknownModel,
} from './registry.js';
