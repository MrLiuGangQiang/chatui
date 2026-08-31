const fs = require('fs');
const path = require('path');

function createPublicConfigReader({ root, contextWindowTokens, contextSummarizeOmitted = false, intentPipelineDeadlineMs = 300000 }) {
  return function readPublicConfig() {
    const file = path.join(root, 'config', 'public.json');
    const fallback = { ui: {}, features: {} };
    const withContext = config => ({ ...config, context: { ...(config.context || {}), windowTokens: contextWindowTokens, summarizeOmitted: contextSummarizeOmitted === true, intentPipelineDeadlineMs } });
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return withContext(fallback);
      return withContext({
        ui: parsed.ui && typeof parsed.ui === 'object' && !Array.isArray(parsed.ui) ? parsed.ui : {},
        features: parsed.features && typeof parsed.features === 'object' && !Array.isArray(parsed.features) ? parsed.features : {},
        context: parsed.context && typeof parsed.context === 'object' && !Array.isArray(parsed.context) ? parsed.context : {},
      });
    } catch {
      return withContext(fallback);
    }
  };
}

module.exports = { createPublicConfigReader };
