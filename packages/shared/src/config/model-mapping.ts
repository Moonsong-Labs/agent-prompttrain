/**
 * Model mapping configuration for Bedrock
 * Maps Anthropic model IDs to AWS Bedrock model IDs
 */

export interface BedrockModelConfig {
  bedrockModelId: string
  region: string
}

/**
 * Map of Anthropic model names to Bedrock model IDs
 * Updated as of November 2025
 */
export const MODEL_MAPPING: Record<string, string> = {
  // Claude 4.5 Opus (Latest - November 2025)
  'claude-opus-4-5': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-opus-4-5-20251101': 'global.anthropic.claude-opus-4-5-20251101-v1:0',

  // Claude 4.5 Haiku (October 2025)
  'claude-haiku-4-5': 'global.anthropic.claude-haiku-4-5-20251015-v1:0',
  'claude-haiku-4-5-20251015': 'global.anthropic.claude-haiku-4-5-20251015-v1:0',
  'claude-haiku-4-5-20251001': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',

  // Claude 4.5 Sonnet (September 2025)
  'claude-sonnet-4-5': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-sonnet-4-5-20250929': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',

  // Claude 4.1 Opus (August 2025)
  'claude-opus-4-1': 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  'claude-opus-4-1-20250805': 'us.anthropic.claude-opus-4-1-20250805-v1:0',

  // Claude 4 Sonnet (May 2025)
  'claude-sonnet-4-20250514': 'global.anthropic.claude-sonnet-4-20250514-v1:0',

  // Claude 4 Opus (May 2025)
  'claude-opus-4-20250514': 'global.anthropic.claude-opus-4-20250514-v1:0',

  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-sonnet-20240620': 'us.anthropic.claude-3-5-sonnet-20240620-v1:0',

  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': 'us.anthropic.claude-3-5-haiku-20241022-v1:0',

  // Claude 3 Opus
  'claude-3-opus-20240229': 'us.anthropic.claude-3-opus-20240229-v1:0',

  // Claude 3 Sonnet
  'claude-3-sonnet-20240229': 'us.anthropic.claude-3-sonnet-20240229-v1:0',

  // Claude 3 Haiku
  'claude-3-haiku-20240307': 'us.anthropic.claude-3-haiku-20240307-v1:0',
}

/**
 * Convert Anthropic model ID to Bedrock model ID
 * Returns the input if no mapping found (allows pass-through of Bedrock IDs)
 */
export function mapToBedrockModel(anthropicModel: string): string {
  return MODEL_MAPPING[anthropicModel] || anthropicModel
}

/**
 * Check if a model ID is already a Bedrock model ID
 */
export function isBedrockModelId(modelId: string): boolean {
  return modelId.includes('anthropic.claude') || modelId.includes('global.anthropic.claude')
}
