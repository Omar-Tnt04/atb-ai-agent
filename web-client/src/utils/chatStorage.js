const titleFallback = 'New conversation';

export const createWelcomeMessage = () => ({
  id: 'welcome',
  sender: 'assistant',
  text: 'How can I assist with your ATB banking request today?',
});

export const getChatStorageKey = (user) => {
  return `atb_chat_threads_${user?.id || user?.email || 'anonymous'}`;
};

export const createChatThread = () => {
  const now = new Date().toISOString();

  return {
    id: `thread_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    title: titleFallback,
    createdAt: now,
    updatedAt: now,
    messages: [createWelcomeMessage()],
    pendingAction: null,
    pendingConfirmation: null,
    pendingSms: null,
    pendingGeneratedFile: null,
    pendingSearchResults: null,
    smsCode: '',
    smsError: '',
    agentContext: { extractedFields: {}, suggestedAction: null },
  };
};

export const getThreadTitleFromMessages = (messages) => {
  const firstUserMessage = messages.find(
    (message) => message.sender === 'user' && message.text?.trim(),
  );

  if (!firstUserMessage) {
    return titleFallback;
  }

  const normalized = firstUserMessage.text.trim().replace(/\s+/g, ' ');
  return normalized.length > 52 ? `${normalized.slice(0, 49)}...` : normalized;
};

export const loadChatThreads = (user) => {
  try {
    const rawThreads = window.localStorage.getItem(getChatStorageKey(user));
    const parsedThreads = rawThreads ? JSON.parse(rawThreads) : [];

    if (!Array.isArray(parsedThreads)) {
      return [];
    }

    return parsedThreads.filter((thread) => thread?.id);
  } catch {
    return [];
  }
};

export const saveChatThreads = (user, threads) => {
  window.localStorage.setItem(getChatStorageKey(user), JSON.stringify(threads));
};

export const formatThreadTime = (value) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
};
