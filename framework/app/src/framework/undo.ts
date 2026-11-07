import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { errorMessage } from './hooks';
import { useToast } from './Toast';

/**
 * Undo a write within its undo window, with the `undo.id` its result carried (an approval
 * level's undo window, declared by the application). The server reverses it and withdraws its
 * held events; the lists in `names`, approvals and history are refreshed. A refusal (it changed
 * since, the window closed) is shown, and resolves false.
 */
export function useUndo() {
  const client = useQueryClient();
  const toast = useToast();
  return async (id: string, names: readonly string[] = []): Promise<boolean> => {
    try {
      await api.undo(id);
      return true;
    } catch (e) {
      toast.show({ tone: 'error', message: errorMessage(e) });
      return false;
    } finally {
      await Promise.all(
        [...names, 'approvals', 'history'].map((n) => client.invalidateQueries({ queryKey: [n] })),
      );
    }
  };
}
