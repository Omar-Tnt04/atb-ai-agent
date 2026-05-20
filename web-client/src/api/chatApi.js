import apiClient from './client';

export const downloadGeneratedFile = ({ fileId, token }) => {
  const url = `${apiClient.defaults.baseURL}/generated/${fileId}/download`;
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', '');

  const authHeader = token ? `Bearer ${token}` : '';
  if (authHeader) {
    fetch(url, { headers: { Authorization: authHeader } })
      .then((res) => {
        const disposition = res.headers.get('content-disposition') || '';
        const nameMatch = disposition.match(/filename="([^"]+)"/);
        const fileName = nameMatch ? nameMatch[1] : 'download';
        return res.blob().then((blob) => ({ blob, fileName }));
      })
      .then(({ blob, fileName }) => {
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {});
    return;
  }

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const sendChatMessage = async ({
  message,
  payload,
  conversationHistory,
  profileContext,
  agentContext,
  token,
}) => {
  const response = await apiClient.post(
    '/chat/message',
    {
      message,
      payload,
      conversationHistory,
      profileContext,
      agentContext: agentContext || {},
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  return response.data;
};

export const sendChatMessageWithFiles = async ({
  message,
  conversationHistory,
  profileContext,
  files,
  token,
}) => {
  const formData = new FormData();
  formData.append('message', message);
  formData.append('conversationHistory', JSON.stringify(conversationHistory || []));
  formData.append('profileContext', JSON.stringify(profileContext || {}));

  files.forEach((file) => {
    formData.append('files', file);
  });

  console.log('Sending files:', files.map((f) => f.name));

  const response = await apiClient.post('/chat/message-with-files', formData, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Must be undefined so axios auto-sets multipart/form-data with boundary.
      // The apiClient default Content-Type: application/json would otherwise
      // clobber the boundary header and multer would receive no files.
      'Content-Type': undefined,
    },
  });

  return response.data;
};
