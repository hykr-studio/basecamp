// The application's modules, as the assistant sees them: one persona, the modules' rules and
// scripts in module order, and one eval suite per module.
import type { AgentDomain, AgentModule, EvalSuite } from './agent-domain.js';

/** A module as the merge needs it: its name and what it teaches the assistant. */
export type AgentModuleOf = { name: string; agent?: AgentModule };

/**
 * One AgentDomain from the application's persona and its modules: rules and scripts
 * concatenated in module order (an earlier module's script matches first), and one eval suite
 * per module. `help` defaults to the modules' help lines.
 */
export function mergeAgentModules(
  app: { persona: string; help?: string },
  modules: readonly AgentModuleOf[],
): AgentDomain {
  const helps = modules.flatMap((m) => (m.agent?.help ? [m.agent.help] : []));
  return {
    persona: app.persona,
    rules: modules.flatMap((m) => m.agent?.rules ?? []),
    help: app.help ?? (helps.join(' ') || 'I can help with the tasks my tools do.'),
    scripts: modules.flatMap((m) => m.agent?.scripts ?? []),
    suites: modules.map((m) => ({
      module: m.name,
      evalCases: m.agent?.evalCases ?? [],
      voiceEvalCases: m.agent?.voiceEvalCases ?? [],
      evalSetup: m.agent?.evalSetup,
    })),
  };
}

/**
 * Turns one module's evals expect it to handle that another module's script would take first
 * (the scripted model runs the first script that matches). Empty means none. The framework's
 * platform scripts run before every module's and are not checked here.
 */
export function scriptConflicts(modules: readonly AgentModuleOf[]): string[] {
  const scripts = modules.flatMap((m) =>
    (m.agent?.scripts ?? []).map((script) => ({ module: m.name, script })),
  );
  const claims = (text: string) =>
    scripts.find(({ script }) => {
      try {
        return script.match(text) !== undefined;
      } catch {
        return false;
      }
    });
  const problems: string[] = [];
  for (const m of modules) {
    const inputs = [...(m.agent?.evalCases ?? []), ...(m.agent?.voiceEvalCases ?? [])].map(
      (c) => c.input,
    );
    for (const input of new Set(inputs)) {
      const first = claims(input);
      if (first && first.module !== m.name)
        problems.push(
          `${m.name}'s eval turn "${input.split('\n')[0]}" is taken by ${first.module}'s script "${first.script.name}"`,
        );
    }
  }
  return problems;
}

/** The suites to run: one module's, or every module's. An unknown module throws. */
export function suitesFor(domain: AgentDomain, module?: string): readonly EvalSuite[] {
  if (module === undefined) return domain.suites;
  const suite = domain.suites.find((s) => s.module === module);
  if (!suite)
    throw new Error(
      `No module called ${module} (modules: ${domain.suites.map((s) => s.module).join(', ')})`,
    );
  return [suite];
}
