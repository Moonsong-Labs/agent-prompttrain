import { SyncRedactor } from 'redact-pii'
import { logger } from './logger.js'
import {
  ANTHROPIC_API_KEY_REGEX,
  CNP_API_KEY_REGEX,
  JWT_TOKEN_REGEX,
  DATABASE_URL_PATTERNS,
} from '@agent-prompttrain/shared'

// Configure PII redaction with custom patterns
const piiRedactor = new SyncRedactor({
  customRedactors: {
    after: [
      // API keys
      { regexpPattern: new RegExp(ANTHROPIC_API_KEY_REGEX.source, 'g'), replaceWith: '[API_KEY]' },
      { regexpPattern: new RegExp(CNP_API_KEY_REGEX.source, 'g'), replaceWith: '[API_KEY]' },
      // JWT tokens
      {
        regexpPattern: new RegExp(JWT_TOKEN_REGEX.source, 'g'),
        replaceWith: '[JWT_TOKEN]',
      },
      // Database URLs
      {
        regexpPattern: new RegExp(DATABASE_URL_PATTERNS.postgresql.source, 'g'),
        replaceWith: '[DATABASE_URL]',
      },
      {
        regexpPattern: new RegExp(DATABASE_URL_PATTERNS.mysql.source, 'g'),
        replaceWith: '[DATABASE_URL]',
      },
      {
        regexpPattern: new RegExp(DATABASE_URL_PATTERNS.mongodb.source, 'g'),
        replaceWith: '[DATABASE_URL]',
      },
    ],
  },
  // Use specific replacements for built-in patterns
  builtInRedactors: {
    creditCardNumber: { replaceWith: '[CREDIT_CARD]' },
    emailAddress: { replaceWith: '[EMAIL]' },
    ipAddress: { replaceWith: '[IP_ADDRESS]' },
    phoneNumber: { replaceWith: '[PHONE]' },
    streetAddress: { replaceWith: '[ADDRESS]' },
    usSocialSecurityNumber: { replaceWith: '[SSN]' },
    zipcode: { replaceWith: '[ZIPCODE]' },
    url: { replaceWith: '[URL]' },
  },
})

export function sanitizeForLLM(content: string): string {
  const startTime = Date.now()

  try {
    // 1. First redact PII
    let sanitized = piiRedactor.redact(content)

    // 2. Remove potential control characters
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')

    // 3. Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim()

    // 4. Remove prompt injection patterns (combined regex for performance)
    const injectionPattern = new RegExp(
      [
        'ignore (previous|all) instructions?',
        'disregard (previous|all) instructions?',
        'forget everything',
        'new task:',
        'system:',
        'assistant:',
        'user:',
        '\\[INST\\]',
        '\\[\\/INST\\]',
        '<\\|im_start\\|>',
        '<\\|im_end\\|>',
      ].join('|'),
      'gi'
    )

    sanitized = sanitized.replace(injectionPattern, '[FILTERED]')

    // 5. Escape HTML-like special characters to prevent command interpretation
    sanitized = sanitized
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

    // 6. Length limiting
    const MAX_CONTENT_LENGTH = 50000
    if (sanitized.length > MAX_CONTENT_LENGTH) {
      sanitized = sanitized.substring(0, MAX_CONTENT_LENGTH) + '... [TRUNCATED]'
    }

    logger.debug(`Content sanitized in ${Date.now() - startTime}ms`, {
      metadata: {
        originalLength: content.length,
        sanitizedLength: sanitized.length,
        piiRedacted: content !== piiRedactor.redact(content),
      },
    })

    return sanitized
  } catch (error) {
    logger.error('Error sanitizing content', { error })
    // On error, return a safe fallback
    return '[SANITIZATION_ERROR]'
  }
}

export interface ValidationResult {
  isValid: boolean
  issues: string[]
}

export function validateAnalysisOutput(output: string): ValidationResult {
  const issues: string[] = []

  // Check if the output contains a JSON code block
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/)

  if (!jsonMatch) {
    // If no JSON block, check for required sections in plain text
    const requiredSections = [
      { name: 'summary', pattern: /summary:?/i },
      { name: 'key topics', pattern: /key\s+topics?:?/i },
      { name: 'patterns', pattern: /patterns?:?/i },
    ]

    requiredSections.forEach(section => {
      if (!section.pattern.test(output)) {
        issues.push(`Missing required section: ${section.name}`)
      }
    })
  } else {
    // If JSON block exists, validate the JSON structure
    try {
      const jsonContent = jsonMatch[1]
      const parsed = JSON.parse(jsonContent)

      // Check for the analysis object
      if (!parsed.analysis) {
        issues.push('Missing "analysis" key in JSON response')
      } else {
        // Check for required fields in the analysis
        const requiredFields = ['summary', 'keyTopics']
        requiredFields.forEach(field => {
          if (!parsed.analysis[field]) {
            issues.push(`Missing required field: ${field}`)
          }
        })
      }
    } catch (_e) {
      issues.push('Invalid JSON in response')
    }
  }

  // Scan for PII leakage in output
  const outputWithRedactedPII = piiRedactor.redact(output)
  if (outputWithRedactedPII !== output) {
    issues.push('Output contains PII that needs to be redacted')
  }

  // Check for suspicious content
  const suspiciousPatterns = [
    /password\s*[:=]\s*\S+/i,
    /api[_\s-]?key\s*[:=]\s*\S+/i,
    /secret\s*[:=]\s*\S+/i,
    /token\s*[:=]\s*\S+/i,
  ]

  suspiciousPatterns.forEach(pattern => {
    if (pattern.test(output)) {
      issues.push('Output contains potentially sensitive information')
    }
  })

  return {
    isValid: issues.length === 0,
    issues,
  }
}

export function enhancePromptForRetry(originalPrompt: string): string {
  return (
    originalPrompt +
    `

CRITICAL REMINDER: You MUST respond with a JSON object wrapped in a json code block.
The JSON must have the following structure:

\`\`\`json
{
  "analysis": {
    "summary": "Your summary here",
    "keyTopics": ["topic1", "topic2", "topic3"],
    "sentiment": "positive/neutral/negative/mixed",
    "userIntent": "What the user was trying to achieve",
    "outcomes": ["outcome1", "outcome2"],
    "actionItems": [
      {
        "type": "task",
        "description": "Specific task description",
        "priority": "high"
      },
      {
        "type": "prompt_improvement",
        "description": "How to improve your prompts",
        "priority": "medium"
      }
    ],
    "promptingTips": [
      {
        "category": "clarity",
        "issue": "Specific issue observed",
        "suggestion": "How to improve",
        "example": "Example of improved prompt"
      }
    ],
    "interactionPatterns": {
      "promptClarity": 7,
      "contextCompleteness": 8,
      "followUpEffectiveness": "good",
      "commonIssues": ["issue1", "issue2"],
      "strengths": ["strength1", "strength2"]
    },
    "technicalDetails": {
      "frameworks": ["framework1", "framework2"],
      "issues": ["issue1", "issue2"],
      "solutions": ["solution1", "solution2"],
      "toolUsageEfficiency": "optimal",
      "contextWindowManagement": "efficient"
    },
    "conversationQuality": {
      "clarity": "high/medium/low",
      "clarityImprovement": "How to improve clarity",
      "completeness": "complete/partial/incomplete",
      "completenessImprovement": "What was missing",
      "effectiveness": "highly effective/effective/needs improvement",
      "effectivenessImprovement": "Key changes for better effectiveness"
    }
  }
}
\`\`\`

Do NOT include any text outside the code block.`
  )
}
