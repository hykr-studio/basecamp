// Binding components to views and screens: one component per name, and a duplicate says who
// bound it. Views and screens are declared here, so this passes with no domain.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineScreen, defineView } from './define-view.js';
import {
  bindingAs,
  bindScreen,
  bindView,
  boundScreens,
  boundViews,
  clearBindings,
  getScreen,
  getView,
} from './react.js';

const Card = defineView({
  name: 'thing.card',
  description: 'One thing.',
  surfaces: ['inline'],
  props: z.object({ title: z.string() }),
  text: (p) => p.title,
  speak: (p) => p.title,
});
const Detail = defineScreen({
  name: 'thing.detail',
  title: 'Thing',
  description: 'A thing.',
  params: z.object({ id: z.string() }),
});
const One = () => null;
const Two = () => null;

describe('bindView and bindScreen', () => {
  afterEach(() => clearBindings());

  it('binds a component to a view and a screen', () => {
    bindView(Card, One);
    bindScreen(Detail, One);
    expect(getView('thing.card')).toBe(One);
    expect(getScreen('thing.detail')).toBe(One);
    expect(boundViews()).toEqual(['thing.card']);
    expect(boundScreens()).toEqual(['thing.detail']);
  });

  it('refuses a second component for the same view, naming both owners', () => {
    bindingAs('meetings', () => bindView(Card, One));
    expect(() => bindingAs('notes', () => bindView(Card, Two))).toThrow(
      'The view "thing.card" is bound twice (by meetings and by notes)',
    );
    // The first binding stands.
    expect(getView('thing.card')).toBe(One);
  });

  it('refuses a second component for the same screen', () => {
    bindScreen(Detail, One);
    expect(() => bindScreen(Detail, Two)).toThrow(
      'The screen "thing.detail" is bound twice (by the app and by the app)',
    );
  });

  it('restores the owner after bindingAs, even when the binding throws', () => {
    bindView(Card, One);
    expect(() => bindingAs('notes', () => bindView(Card, Two))).toThrow();
    expect(() => bindScreen(Detail, One)).not.toThrow();
    clearBindings();
    bindingAs('todos', () => bindScreen(Detail, One));
    expect(() => bindScreen(Detail, Two)).toThrow('(by todos and by the app)');
  });

  it('binds again after clearBindings', () => {
    bindView(Card, One);
    clearBindings();
    expect(getView('thing.card')).toBeUndefined();
    bindView(Card, Two);
    expect(getView('thing.card')).toBe(Two);
  });
});
