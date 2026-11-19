// Reading files with a model, without booting (A12): which pages a read takes, images scaled to
// the longest side allowed, a PDF drawn page by page with its text layer, and what is refused.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  choosePages,
  fitImage,
  prepare,
  readableProblem,
} from '../../dist/features/files/read/prepare.js';

const LIMITS = { maxBytes: 5_000_000, maxPages: 3, maxSide: 2048, dpi: 72 };

const pngOf = (width: number, height: number) => {
  const c = createCanvas(width, height);
  c.getContext('2d').fillRect(0, 0, 10, 10);
  return c.toBuffer('image/png');
};

describe('pages', () => {
  it('every page within the limit, the ones asked for, or a refusal', () => {
    expect(choosePages(2, undefined, 3)).toEqual([1, 2]);
    expect(choosePages(12, [1, 2, 2], 3)).toEqual([1, 2]);
    expect(() => choosePages(12, undefined, 3)).toThrow(/at most 3/);
    expect(() => choosePages(2, [3], 3)).toThrow(/no page 3/);
    expect(() => choosePages(12, [1, 2, 3, 4], 3)).toThrow(/At most 3/);
  });
});

describe('images', () => {
  it('within the longest side: sent as they are; larger: scaled down as JPEG', async () => {
    const small = pngOf(300, 200);
    expect((await fitImage(small, 'image/png', 2048)).data).toEqual(new Uint8Array(small));
    const wide = await fitImage(pngOf(4096, 1024), 'image/png', 2048);
    expect(wide.mediaType).toBe('image/jpeg');
    expect(Buffer.from(wide.data).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('refuses what it cannot read: HEIC, SVG, audio, too large', () => {
    expect(readableProblem({ mime: 'image/heic', size: 10 }, LIMITS)?.getStatus()).toBe(422);
    expect(
      readableProblem({ mime: 'image/svg+xml', size: 10 }, LIMITS)?.getResponse(),
    ).toMatchObject({
      error: 'unsupported_type',
    });
    expect(readableProblem({ mime: 'audio/ogg', size: 10 }, LIMITS)).toBeDefined();
    expect(
      readableProblem({ mime: 'image/png', size: 6_000_000 }, LIMITS)?.getResponse(),
    ).toMatchObject({
      error: 'too_large',
    });
    expect(readableProblem({ mime: 'application/pdf', size: 10 }, LIMITS)).toBeUndefined();
  });

  it('a file whose bytes are not its type is refused', async () => {
    await expect(
      prepare(Buffer.from('not a png'), 'image/png', { takesPdf: false, limits: LIMITS }),
    ).rejects.toThrow(/Not a image\/png image/);
  });
});
