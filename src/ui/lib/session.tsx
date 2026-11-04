/**
 * Sitzung: angemeldete Person, Knoten, Rollenprüfung gegen den Vertrag.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext } from 'react';
import { type Role, type RouteId, routes } from '../../shared/contract/index.ts';
import { ApiError, type ApiOutput, api, setAuthHandlers } from './api.ts';
import { queryClient, queryKey } from './query.ts';

export type Me = ApiOutput<'auth.me'>;

const ME_KEY = queryKey('auth.me', {});

/** true, wenn eine Person mit diesen Rollen die Route aufrufen darf (laut Vertrag). */
export function canCall(roles: readonly Role[], id: RouteId): boolean {
  const rule = routes[id].auth;
  if (rule === 'public' || rule === 'authenticated') return true;
  return rule.some((r) => roles.includes(r));
}

export function canCallAny(roles: readonly Role[], ids: readonly RouteId[]): boolean {
  return ids.some((id) => canCall(roles, id));
}

// Globale Reaktionen: Sitzung abgelaufen → Anmeldung; Passwortwechsel erzwungen → Wechselmaske.
setAuthHandlers({
  onUnauthenticated: () => {
    queryClient.setQueryData<Me | null>(ME_KEY, null);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth.me' });
  },
  onPasswordChangeRequired: () => {
    queryClient.setQueryData<Me | null>(ME_KEY, (prev) =>
      prev ? { ...prev, user: { ...prev.user, mustChangePassword: true } } : prev,
    );
  },
});

/** auth.me; null = nicht angemeldet */
export function useMe() {
  return useQuery<Me | null, ApiError>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api('auth.me', {});
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, e) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && count < 2,
  });
}

export interface Session {
  user: Me['user'];
  node: Me['node'];
  roles: readonly Role[];
  can: (id: RouteId) => boolean;
  canAny: (ids: readonly RouteId[]) => boolean;
  hasRole: (role: Role) => boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const roles = me.user.roles;
  const value: Session = {
    user: me.user,
    node: me.node,
    roles,
    can: (id) => canCall(roles, id),
    canAny: (ids) => canCallAny(roles, ids),
    hasRole: (role) => roles.includes(role),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Abmelden: Server-Sitzung beenden, Cache leeren. */
export function useSignOut(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    try {
      await api('auth.logout', {});
    } catch {
      // auch bei Fehler lokal abmelden
    }
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth.me' });
    qc.setQueryData<Me | null>(ME_KEY, null);
  }, [qc]);
}

/** Nach Anmeldung oder Passwortwechsel die Sitzung neu laden. */
export function useReloadSession(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ME_KEY });
  }, [qc]);
}
