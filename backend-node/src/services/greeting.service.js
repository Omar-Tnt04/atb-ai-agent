// Exact greetings bypass retrieval; substantive questions continue normally.
function greetingResponse(message) {
 const text = String(message || '').trim().toLowerCase().replace(/[!?.]+$/g, '').trim();
 if (/^(bonjour|salut|bonsoir)(\s+(a vous|\u00e0 vous|atb))?$/.test(text))
  return 'Bonjour ! Je peux r\u00e9pondre \u00e0 vos questions sur les informations publiques de l\'ATB. Pour une action sur une page, s\u00e9lectionnez "Act on site". Comment puis-je vous aider ?';
 if (/^(hello|hi|hey)(\s+(there|atb))?$/.test(text))
  return 'Hello! I can answer questions about public ATB information. Select "Act on site" for a page action. How can I help?';
 return null;
}
module.exports = { greetingResponse };
