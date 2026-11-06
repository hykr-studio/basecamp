import { ModelsCapability, reserveRoutes } from '@hykr/contracts';
import { defineFeature } from '../feature.js';
import { ModelPolicyService } from './model-policy.service.js';
import { ModelsController } from './models.controller.js';

// GET /api/models and PUT /api/models/policy: no module may take the segment.
reserveRoutes('models');

/**
 * The deployment's models (MODEL_PROVIDERS: OpenAI-compatible gateways, OpenRouter in
 * development) and each business's model policy over them. Its service chooses every turn's
 * model and every embedding model, failing closed.
 */
export const modelsFeature = defineFeature({
  name: 'models',
  controllers: [ModelsController],
  providers: [ModelPolicyService],
  exports: [ModelPolicyService],
  contributes: { capabilities: [ModelsCapability] },
});

export { ModelPolicyService, ModelRefused } from './model-policy.service.js';
export { ModelPolicyChanged, SET_MODEL_POLICY } from './set-policy.js';
