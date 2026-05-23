import apiClient from './client';

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

export const getConnectors = async (token) => {
  const response = await apiClient.get('/integrations/connectors', {
    headers: authHeaders(token),
  });

  return response.data;
};

export const getInternalServiceStatus = async (token) => {
  const response = await apiClient.get('/integrations/internal/status', {
    headers: authHeaders(token),
  });

  return response.data;
};
