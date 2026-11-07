// The declared feature flags, checked when the process starts (A11): a flag that names a module,
// entity, command or tool the application does not have would gate nothing, so the start fails.
import { featureFlagProblems, featureFlags } from '@hykr/contracts';
import { toolsFor } from '@hykr/core/tools';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { runtime } from '../../runtime.js';

@Injectable()
export class FeatureFlagsCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    const flags = featureFlags.all();
    if (!flags.length) return;
    const { catalog, registry } = runtime();
    const clientFor = () => {
      throw new Error('Tools built at startup are only checked, never called');
    };
    const tools = Object.keys(toolsFor({ clientFor, registry }, catalog, { canvas: true }));
    const problems = featureFlagProblems(flags, {
      modules: catalog.modules.map((m) => m.name),
      entities: Object.values(catalog.entities).map((e) => e.name),
      commands: catalog.commands.map((c) => c.name),
      tools,
    });
    if (problems.length) throw new Error(`Feature flags:\n- ${problems.join('\n- ')}`);
  }
}
