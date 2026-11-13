// The boot check of the application's languages (docs/decisions/HLANG.md): every word the
// modules declare is keyed by a language the application speaks (an undeclared key is a typo or
// a language it does not speak, and is never shown), every voice eval case is in one, and every
// language's WhatsApp keywords name a keyword. A missing language is not a problem: it reads in
// English.
import { keywordProblems } from '@hykr/channels';
import type { Contributions } from '@hykr/contracts';
import type { Labels, Languages } from '@hykr/i18n';
import { languageProblems } from '@hykr/ui-registry';
import type { ModuleDef } from './module.js';

const undeclared = (set: Languages, words: Labels | undefined, what: string) =>
  Object.keys(words ?? {})
    .filter((lang) => !set.has(lang))
    .map((lang) => `${what} is in "${lang}", not one of the application's languages`);

export function languageCheckProblems(input: {
  modules: readonly ModuleDef[];
  languages: Languages;
  does?: Labels;
  /** The server's own contributions (its meters' labels). */
  contributes?: Partial<Contributions>;
}): string[] {
  const { modules, languages: set } = input;
  const problems = [
    ...undeclared(set, input.does, 'channel.does'),
    ...keywordProblems(set),
    ...languageProblems(
      modules.flatMap((m) => m.views ?? []),
      set,
    ),
  ];
  for (const m of modules) {
    for (const spec of Object.values(m.entities ?? {}))
      for (const [field, words] of Object.entries(spec.fieldLabels ?? {}))
        problems.push(
          ...undeclared(set, words as Labels, `${m.name}: ${spec.name}.${field}'s label`),
        );
    for (const t of m.templates ?? []) {
      problems.push(...undeclared(set, t.body, `${m.name}: the template ${t.name}'s body`));
      problems.push(...undeclared(set, t.footer, `${m.name}: the template ${t.name}'s footer`));
      for (const b of t.buttons ?? [])
        problems.push(...undeclared(set, b.text, `${m.name}: the template ${t.name}'s button`));
    }
    for (const c of m.agent?.voiceEvalCases ?? [])
      if (!set.has(c.lang))
        problems.push(
          `${m.name}: the voice eval case "${c.why}" is in "${c.lang}", not one of the application's languages`,
        );
  }
  // What a meter is called, where a refusal and the credits screen name it.
  const meters = [
    ...modules.flatMap((m) =>
      (m.contributes?.meters ?? []).map((meter) => ({ by: m.name, meter })),
    ),
    ...(input.contributes?.meters ?? []).map((meter) => ({ by: 'the server', meter })),
  ];
  for (const { by, meter } of meters)
    problems.push(...undeclared(set, meter.label, `${by}: the meter ${meter.name}'s label`));
  return problems;
}
