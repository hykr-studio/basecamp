import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { ModelPolicy } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { visionReply } from '../fake/vision.js';
import { ModelConfigError, parseProviders } from './config.js';
import { chooseVision, policyProblems } from './policy.js';
import { modelRegistry } from './registry.js';

const PROVIDERS = [
  {
    id: 'gw',
    baseUrl: 'https://gateway.test/v1',
    region: 'north',
    models: [
      { id: 'text' },
      { id: 'eye', capabilities: ['vision'] },
      { id: 'docs', capabilities: ['vision', 'pdf'] },
    ],
  },
  {
    id: 'far',
    baseUrl: 'https://far.test/v1',
    region: 'south',
    models: [{ id: 'eye', capabilities: ['vision'] }],
  },
];
const registry = (extra: Record<string, string> = {}) =>
  modelRegistry({
    MODEL_MODE: 'live',
    MODEL_PROVIDERS: JSON.stringify(PROVIDERS),
    AGENT_MODEL: 'gw/text',
    ...extra,
  });
const policy = (p: object = {}) => ModelPolicy.parse(p);

describe('capabilities', () => {
  it('are listed on chat models, none by default', () => {
    const r = registry();
    expect(r.get('gw/text')?.capabilities).toEqual([]);
    expect(r.get('gw/docs')?.capabilities).toEqual(['vision', 'pdf']);
  });

  it('are refused on an embedding model, and an unknown capability', () => {
    expect(() =>
      parseProviders(
        JSON.stringify([
          {
            id: 'x',
            baseUrl: 'https://x.test',
            models: [{ id: 'e', kind: 'embedding', capabilities: ['vision'] }],
          },
        ]),
      ),
    ).toThrow(ModelConfigError);
    expect(() =>
      parseProviders(
        JSON.stringify([
          { id: 'x', baseUrl: 'https://x.test', models: [{ id: 'm', capabilities: ['audio'] }] },
        ]),
      ),
    ).toThrow(ModelConfigError);
  });
});

describe('the vision model', () => {
  it("is the policy's vision, else the chat model if it has vision; never a fallback", () => {
    expect(
      chooseVision(registry(), policy({ allowed: ['gw/text', 'gw/eye'], vision: 'gw/eye' })),
    ).toMatchObject({
      ok: true,
      ref: 'gw/eye',
    });
    expect(
      chooseVision(registry(), policy({ allowed: ['gw/docs'], chat: 'gw/docs' })),
    ).toMatchObject({
      ok: true,
      ref: 'gw/docs',
    });
    // The default chat model reads no images: refused, not replaced by a model that does.
    expect(chooseVision(registry(), policy())).toMatchObject({
      ok: false,
      rule: 'no_vision_model',
      status: 409,
    });
  });

  it('must be allowed and in the regions', () => {
    expect(
      chooseVision(registry(), policy({ allowed: ['gw/text'], vision: 'gw/eye' })),
    ).toMatchObject({
      ok: false,
      rule: 'no_vision_model',
    });
    expect(
      chooseVision(
        registry(),
        policy({ allowed: ['far/eye'], vision: 'far/eye', regions: ['north'] }),
      ),
    ).toMatchObject({ ok: false, rule: 'no_vision_model' });
  });

  it('a policy naming a text-only vision model cannot be saved', () => {
    expect(
      policyProblems(registry(), policy({ allowed: ['gw/text'], vision: 'gw/text' })).join(' '),
    ).toContain('cannot read images');
    expect(policyProblems(registry(), policy({ allowed: ['gw/text'] }))).toEqual([]);
  });

  it('in fake mode the scripted model reads files', () => {
    expect(chooseVision(modelRegistry({ MODEL_MODE: 'fake' }), policy())).toMatchObject({
      ok: true,
      ref: 'fake/scripted',
    });
  });
});

describe('the scripted vision model', () => {
  const file = (text: string) => ({
    type: 'file' as const,
    mediaType: 'image/png',
    data: new Uint8Array(Buffer.from(`\x89PNG....FAKE-VISION:${text}`)),
  });
  const prompt = (...parts: object[]): LanguageModelV2Prompt => [
    { role: 'user', content: [{ type: 'text', text: 'Read this file.' }, ...parts] as never },
  ];

  it('sees what follows the marker, in bytes or text', () => {
    expect(visionReply(prompt(file('Total 1,250 ✓')))).toBe('Total 1,250 ✓');
    expect(
      visionReply(prompt({ type: 'text', text: 'Page 2, its text layer: FAKE-VISION:Two' })),
    ).toBe('Two');
    expect(
      visionReply(prompt({ type: 'file', mediaType: 'image/png', data: new Uint8Array(4) })),
    ).toBe('I see 1 image and no words.');
  });

  it('answers the retry with the next alternative', () => {
    const first = prompt(file('wrong|||right'));
    expect(visionReply(first)).toBe('wrong');
    expect(
      visionReply([
        ...first,
        { role: 'assistant', content: [{ type: 'text', text: 'wrong' }] },
        { role: 'user', content: [{ type: 'text', text: 'Again.' }] },
      ]),
    ).toBe('right');
  });
});
