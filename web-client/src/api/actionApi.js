import apiClient from './client';

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

export const executeAction = async ({ actionName, payload, token }) => {
  const response = await apiClient.post(
    '/agent/actions/execute',
    {
      actionName,
      payload,
    },
    {
      headers: authHeaders(token),
    },
  );

  return response.data;
};

export const confirmAction = async ({ confirmationId, token }) => {
  const response = await apiClient.post(
    '/agent/actions/confirm',
    {
      confirmationId,
    },
    {
      headers: authHeaders(token),
    },
  );

  return response.data;
};

export const cancelAction = async ({ confirmationId, token }) => {
  const response = await apiClient.post(
    '/agent/actions/cancel',
    {
      confirmationId,
    },
    {
      headers: authHeaders(token),
    },
  );

  return response.data;
};

export const verifyAndExecuteAction = async ({ confirmationId, code, token }) => {
  const response = await apiClient.post(
    '/agent/actions/verify-and-execute',
    {
      confirmationId,
      code,
    },
    {
      headers: authHeaders(token),
    },
  );

  return response.data;
};
