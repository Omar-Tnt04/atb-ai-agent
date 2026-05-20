import apiClient from './client';

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

export const getMyAuditLogs = async (token) => {
  const response = await apiClient.get('/agent/audit/me', {
    headers: authHeaders(token),
  });

  return response.data;
};

export const getAllAuditLogs = async (token) => {
  const response = await apiClient.get('/agent/audit', {
    headers: authHeaders(token),
  });

  return response.data;
};
