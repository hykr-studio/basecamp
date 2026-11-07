// What a scoped credential (an MCP client's OAuth token, A1) may reach: scopes per module, read
// or write. The application's modules give the list; the framework holds no scope names of its
// own. The API checks them on every route a scoped credential calls (PrincipalGuard).

/** Reading a module's records, or also changing them. */
export type ScopeAccess = 'read' | 'write';

/** One module's scope: 'orders:read', 'orders:write'. */
export const scopeOf = (module: string, access: ScopeAccess) => `${module}:${access}`;

/** Every scope the modules give, read then write for each, in module order. */
export function moduleScopes(modules: readonly { name: string }[]): string[] {
  return modules.flatMap((m) => [scopeOf(m.name, 'read'), scopeOf(m.name, 'write')]);
}

/** The module and access a scope names, or null for any other scope ('offline_access'). */
export function parseScope(scope: string): { module: string; access: ScopeAccess } | null {
  const m = /^([a-z][a-z0-9_]*):(read|write)$/.exec(scope);
  return m ? { module: m[1], access: m[2] as ScopeAccess } : null;
}

/** Whether these scopes reach a module for this access. Write covers read. */
export function scopeCovers(
  scopes: readonly string[],
  module: string,
  access: ScopeAccess,
): boolean {
  return (
    scopes.includes(scopeOf(module, 'write')) ||
    (access === 'read' && scopes.includes(scopeOf(module, 'read')))
  );
}

/** The modules these scopes reach for this access, in the order given. */
export function modulesCovered<M extends { name: string }>(
  modules: readonly M[],
  scopes: readonly string[],
  access: ScopeAccess,
): M[] {
  return modules.filter((m) => scopeCovers(scopes, m.name, access));
}
