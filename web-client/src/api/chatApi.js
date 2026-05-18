import apiClient from './client';

export const sendChatMessage = async ({
  message,
  payload,
  conversationHistory,
  token,
}) => {
  const response = await apiClient.post(
    '/chat/message',
    {
      message,
      payload,
      conversationHistory,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
};
