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

export const getExternalStatus = async (token) => {
  const response = await apiClient.get('/integrations/external/status', {
    headers: authHeaders(token),
  });

  return response.data;
};
