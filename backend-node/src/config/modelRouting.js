const ROUTING_MODES = new Set(['hybrid', 'text_only', 'vision_only']);

const normalizeRoutingMode = (value) => {
  const mode = String(value || '').trim().toLowerCase();
  return ROUTING_MODES.has(mode) ? mode : 'hybrid';
};

const config = {
  mode: normalizeRoutingMode(process.env.MODEL_ROUTING_MODE),
  textModel: process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:7b',
  visionModel: process.env.OLLAMA_VISION_MODEL || 'qwen3-vl:8b',
  textKeepAlive: process.env.OLLAMA_TEXT_KEEP_ALIVE || '30s',
  visionKeepAlive: process.env.OLLAMA_VISION_KEEP_ALIVE || '0s',
};

const selectModelForConfig = (routingConfig, { requiresVision = false } = {}) => {
  if (routingConfig.mode === 'vision_only') {
    return {
      modelRoutingMode: routingConfig.mode,
      selectedModel: routingConfig.visionModel,
      selectedKeepAlive: routingConfig.visionKeepAlive,
      selectedModelReason: requiresVision
        ? 'vision_only routes visual tasks to the vision model'
        : 'vision_only routes text tasks to the vision model',
      visionUsed: requiresVision,
      directVisionSupported: true,
    };
  }

  if (routingConfig.mode === 'text_only') {
    return {
      modelRoutingMode: routingConfig.mode,
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
    modelRoutingMode: routingConfig.mode,
    selectedModel: requiresVision ? routingConfig.visionModel : routingConfig.textModel,
    selectedKeepAlive: requiresVision ? routingConfig.visionKeepAlive : routingConfig.textKeepAlive,
    selectedModelReason: requiresVision
      ? 'hybrid routes image, scanned, and visual tasks to the vision model'
      : 'hybrid routes JSON, TXT, PDF-text, and resource tasks to the text model',
    visionUsed: requiresVision,
    directVisionSupported: true,
  };
};

const selectModel = (options = {}) => selectModelForConfig(config, options);

module.exports = {
  modelRoutingConfig: config,
  normalizeRoutingMode,
  selectModel,
  selectModelForConfig,
};
