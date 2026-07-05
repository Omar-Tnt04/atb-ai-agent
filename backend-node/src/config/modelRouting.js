const ROUTING_MODES = new Set(['hybrid', 'text_only']);

const normalizeRoutingMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'vision_only') return 'text_only';
  return ROUTING_MODES.has(mode) ? mode : 'hybrid';
};

const config = {
  mode: normalizeRoutingMode(process.env.MODEL_ROUTING_MODE),
  textModel: process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:7b',
  textKeepAlive: process.env.OLLAMA_TEXT_KEEP_ALIVE || '30s',
  visionModel: null,
  visionKeepAlive: null,
};

const selectModelForConfig = (routingConfig, { requiresVision = false } = {}) => {
  const mode = normalizeRoutingMode(routingConfig.mode);
  if (mode === 'text_only') {
    return {
      modelRoutingMode: mode,
      selectedModel: routingConfig.textModel,
      selectedKeepAlive: routingConfig.textKeepAlive,
      selectedModelReason: requiresVision
        ? 'text_only uses the text model; direct vision is unsupported'
        : 'text_only routes text tasks to the text model',
      visionUsed: false,
      directVisionSupported: false,
    };
  }

  return {
    modelRoutingMode: mode,
    selectedModel: routingConfig.textModel,
    selectedKeepAlive: routingConfig.textKeepAlive,
    selectedModelReason: requiresVision
      ? 'vision runtime is disabled; OCR output is handled by the text model'
      : 'hybrid routes JSON, TXT, PDF-text, and resource tasks to the text model',
    visionUsed: false,
    directVisionSupported: false,
  };
};

const selectModel = (options = {}) => selectModelForConfig(config, options);

module.exports = {
  modelRoutingConfig: config,
  normalizeRoutingMode,
  selectModel,
  selectModelForConfig,
};
