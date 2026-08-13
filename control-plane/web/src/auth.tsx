import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest, jsonBody } from './api';
import type { OrganizationSummary, SessionResponse } from './types';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => apiRequest<SessionResponse>('/api/v1/auth/session'),
    retry: false,
    staleTime: 15_000,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      apiRequest<SessionResponse>('/api/v1/auth/login', {
        method: 'POST',
        ...jsonBody(input),
      }),
    onSuccess: (session) => client.setQueryData(['session'], session),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/v1/auth/logout', { method: 'POST', ...jsonBody({}) }),
    onSuccess: () => client.clear(),
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiRequest<{ organizations: OrganizationSummary[] }>('/api/v1/organizations'),
  });
}

export function useSelectOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      apiRequest<SessionResponse>('/api/v1/organizations/select', {
        method: 'POST',
        ...jsonBody({ organization_id: organizationId }),
      }),
    onSuccess: (session) => {
      client.clear();
      client.setQueryData(['session'], session);
    },
  });
}
