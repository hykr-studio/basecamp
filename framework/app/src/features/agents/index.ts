import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { AgentEditor } from './AgentEditor';
import { AgentRunScreen } from './AgentRunScreen';
import { AgentsScreen } from './AgentsScreen';

export { AgentEditor } from './AgentEditor';
export { AgentRunScreen } from './AgentRunScreen';
export { AgentsScreen } from './AgentsScreen';
export { draftOf, inputOf, newDraft, triggerWords } from './form';

/** Who sees the destination: people who make agents or manage the business's. */
const SEES = ['agents.create', 'agents.manage'];

const destination: NavItem = {
  href: '/agents',
  label: 'Agents',
  icon: 'zap',
  match: (path) => path === '/agents' || path.startsWith('/agents/'),
};

/**
 * The business's agents (A6): `/agents` (the list, ready-made ones, the latest runs), the editor
 * (`/agents/new`, `/agents/new/:template`, `/agents/:id`, with its run log) and one run
 * (`/agents/runs/:id`). The destination shows to holders of `agents.create` or `agents.manage`.
 * List it in `<AppShell plugins>`.
 */
export function agentsPlugin(): AppPlugin {
  return {
    name: 'agents',
    routes: [
      { path: '/agents', screen: AgentsScreen },
      { path: '/agents/new', screen: AgentEditor },
      { path: '/agents/new/:template', screen: AgentEditor },
      { path: '/agents/runs/:id', screen: AgentRunScreen },
      { path: '/agents/:id', screen: AgentEditor },
    ],
    nav: [destination],
    useNav: (items) => {
      const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
      const sees = SEES.some((c) => me.data?.capabilities.includes(c));
      return sees ? items : items.filter((i) => i.href !== destination.href);
    },
  };
}
