/**
 * The account module's specs: the business's own account with the platform. It has no records
 * of its own; it is where the application words what the framework's credits tell it.
 */
import { moduleSpec } from '@hykr/contracts';

export const accountSpec = moduleSpec({
  name: 'account',
  dependsOn: [],
  entities: {},
  commands: [],
});
