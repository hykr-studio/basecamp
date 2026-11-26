import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({}));

const { hrefOf, keepPlace, takeKeptPlace } = await import('./place');

describe('the place kept across a remount of the shell', () => {
  it("is the path and its query, without the route's own segments", () => {
    expect(hrefOf('/approvals/a1', { id: 'a1' }, ['approvals', '[id]'])).toBe('/approvals/a1');
    expect(hrefOf('/businesses/join', { token: 'abc', from: 'mail' }, ['businesses', 'join'])).toBe(
      '/businesses/join?token=abc&from=mail',
    );
    expect(hrefOf('/files/a/b', { rest: ['a', 'b'], v: '2' }, ['files', '[...rest]'])).toBe(
      '/files/a/b?v=2',
    );
    expect(hrefOf('/todos', { tag: ['x', 'y'] }, ['todos'])).toBe('/todos?tag=x&tag=y');
    expect(hrefOf('/', {}, [])).toBe('/');
  });

  it('is taken once', () => {
    expect(takeKeptPlace()).toBeNull();
    keepPlace('/orders/o1');
    expect(takeKeptPlace()).toBe('/orders/o1');
    expect(takeKeptPlace()).toBeNull();
  });
});
