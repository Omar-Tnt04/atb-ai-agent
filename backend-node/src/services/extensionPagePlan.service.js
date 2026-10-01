// Return declarative actions for the extension to validate and execute in its own tab.
function extensionPagePlan(action) {
  const document = ['download', 'navigate_then_download'].includes(action.type);
  return {
    success: true,
    assistantMessage: document ? `Opening ${action.title || 'the document'}.` : `Opening ${action.title || 'the page'}.`,
    pagePlan: {
      status: document ? 'done' : 'navigated',
      actions: [{
        type: document ? 'openDocumentUrl' : 'navigateTo',
        url: document ? (action.documentUrl || action.url) : (action.sourceUrl || action.url),
        ...(action.type === 'navigate_then_download' ? { sourceUrl: action.sourceUrl } : {}),
      }],
    },
  };
}
module.exports = { extensionPagePlan };
