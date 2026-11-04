/**
 * React-Query-Anbindung des typisierten Clients.
 * Query-Keys: [routeId, input] – Invalidierung über die Routen-ID (Präfix).
 */
import {
  QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { RouteId } from '../../shared/contract/index.ts';
import { ApiError, type ApiInput, type ApiOutput, api } from './api.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status > 0 && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

export function queryKey<K extends RouteId>(id: K, input?: ApiInput<K>): readonly unknown[] {
  return [id, input ?? {}];
}

export interface ApiQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** vorherige Daten beim Wechsel der Eingabe (z. B. Seitenwechsel) stehen lassen */
  keepPrevious?: boolean;
}

export function useApiQuery<K extends RouteId>(
  id: K,
  input: ApiInput<K>,
  options: ApiQueryOptions = {},
): UseQueryResult<ApiOutput<K>, ApiError> {
  return useQuery<ApiOutput<K>, ApiError>({
    queryKey: queryKey(id, input),
    queryFn: () => api(id, input),
    enabled: options.enabled,
    staleTime: options.staleTime,
    refetchInterval: options.refetchInterval,
    placeholderData: options.keepPrevious ? (prev) => prev : undefined,
  });
}

export interface ApiMutationOptions<K extends RouteId> {
  /** Routen, deren Abfragen nach Erfolg neu geladen werden */
  invalidate?: readonly RouteId[];
  onSuccess?: (data: ApiOutput<K>, input: ApiInput<K>) => void;
}

export function useApiMutation<K extends RouteId>(
  id: K,
  options: ApiMutationOptions<K> = {},
): UseMutationResult<ApiOutput<K>, ApiError, ApiInput<K>> {
  const qc = useQueryClient();
  return useMutation<ApiOutput<K>, ApiError, ApiInput<K>>({
    mutationFn: (input) => api(id, input),
    onSuccess: async (data, input) => {
      await Promise.all((options.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: [k] })));
      options.onSuccess?.(data, input);
    },
  });
}
