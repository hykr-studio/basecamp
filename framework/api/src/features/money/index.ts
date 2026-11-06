import { moneyPlugin, parentPlugin } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { MoneyController } from './money.controller.js';

/**
 * Money and records with a parent: the `money` and `parent` entity plugins (they act only on
 * specs with their trait) and GET /api/money. The money list field type's SQL is built in.
 */
export const moneyFeature = defineFeature({
  name: 'money',
  controllers: [MoneyController],
  contributes: { entityPlugins: [moneyPlugin, parentPlugin] },
});
