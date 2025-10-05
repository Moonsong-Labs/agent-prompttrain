import { describe, it, expect } from 'bun:test'
import { buildAnalysisPrompt, parseAnalysisResponse } from '../analysis/index'
import type { Message } from '../truncation'

describe('buildAnalysisPrompt', () => {
  const createTestMessages = (): Message[] => [
    { role: 'user', content: 'How do I set up authentication in Next.js?' },
    {
      role: 'model',
      content:
        "You can use NextAuth.js for authentication in Next.js. Here's how to get started...",
    },
    { role: 'user', content: 'Can you show me an example?' },
    {
      role: 'model',
      content: "Sure! Here's a complete example of setting up NextAuth.js with Google OAuth...",
    },
  ]

  it('should build a multi-turn prompt with correct structure', () => {
    const messages = createTestMessages()
    const result = buildAnalysisPrompt(messages)

    // Should have original messages + final instruction
    expect(result.length).toBe(messages.length + 1)

    // Check that messages are preserved with correct roles
    for (let i = 0; i < messages.length; i++) {
      expect(result[i].role).toBe(messages[i].role)
      expect(result[i].parts[0].text).toBe(messages[i].content)
    }

    // Check final instruction
    const lastContent = result[result.length - 1]
    expect(lastContent.role).toBe('user')
    expect(lastContent.parts[0].text).toContain('Based on the preceding conversation')
    expect(lastContent.parts[0].text).toContain('JSON Schema')
    expect(lastContent.parts[0].text).toContain('Examples')
  })

  it('should include JSON schema in the prompt', () => {
    const messages = createTestMessages()
    const result = buildAnalysisPrompt(messages)

    const instruction = result[result.length - 1].parts[0].text

    // Check for schema properties
    expect(instruction).toContain('summary')
    expect(instruction).toContain('keyTopics')
    expect(instruction).toContain('sentiment')
    expect(instruction).toContain('userIntent')
    expect(instruction).toContain('outcomes')
    expect(instruction).toContain('actionItems')
    expect(instruction).toContain('technicalDetails')
    expect(instruction).toContain('conversationQuality')
  })

  it('should include examples in the prompt', () => {
    const messages = createTestMessages()
    const result = buildAnalysisPrompt(messages)

    const instruction = result[result.length - 1].parts[0].text

    // Check for example content
    expect(instruction).toContain('Example 1')
    expect(instruction).toContain('Example 2')
    expect(instruction).toContain('Next.js authentication')
    expect(instruction).toContain('ModuleNotFoundError')
  })

  it(
    'should handle truncation for long conversations',
    () => {
      // Create a very long conversation
      const messages: Message[] = []
      // Need enough content to trigger truncation with ~12 chars/token
      const longContent = 'The quick brown fox jumps over the lazy dog. '.repeat(5000) // ~225k chars per message

      for (let i = 0; i < 100; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'model',
          content: longContent + ` (Message ${i})`,
        })
      }

      const result = buildAnalysisPrompt(messages)

      // Should have truncated messages + instruction
      // Look for truncation marker
      const hasTruncationMarker = result.some(content =>
        content.parts[0].text.includes('[...conversation truncated...]')
      )

      expect(hasTruncationMarker).toBe(true)
    },
    { timeout: 60000 }
  )

  it('should handle empty conversation', () => {
    const result = buildAnalysisPrompt([])

    // Should only have the instruction
    expect(result.length).toBe(1)
    expect(result[0].role).toBe('user')
    expect(result[0].parts[0].text).toContain('Based on the preceding conversation')
  })

  it('should format content correctly for Gemini API', () => {
    const messages = createTestMessages()
    const result = buildAnalysisPrompt(messages)

    // Check that all content follows GeminiContent interface
    result.forEach(content => {
      expect(content).toHaveProperty('role')
      expect(content).toHaveProperty('parts')
      expect(Array.isArray(content.parts)).toBe(true)
      expect(content.parts.length).toBeGreaterThan(0)

      content.parts.forEach(part => {
        expect(part).toHaveProperty('text')
        expect(typeof part.text).toBe('string')
      })
    })
  })
})

describe('parseAnalysisResponse', () => {
  it('should parse valid JSON response', () => {
    const validResponse = `\`\`\`json
{
  "analysis": {
    "summary": "User asked about Next.js authentication and received comprehensive guidance.",
    "keyTopics": ["Next.js", "Authentication", "NextAuth.js"],
    "sentiment": "positive",
    "userIntent": "Learn how to implement authentication in Next.js",
    "outcomes": ["Received authentication setup instructions", "Got code examples"],
    "actionItems": [
      { "type": "task", "description": "Install NextAuth.js", "priority": "high" },
      { "type": "task", "description": "Configure providers", "priority": "medium" }
    ],
    "promptingTips": [
      {
        "category": "specificity",
        "issue": "Authentication provider not specified",
        "suggestion": "Be more specific about which authentication provider you want to use",
        "example": "I want to implement Google OAuth with NextAuth.js"
      },
      {
        "category": "context",
        "issue": "Missing version information",
        "suggestion": "Include your current Next.js version for version-specific advice"
      },
      {
        "category": "structure",
        "issue": "Authentication flow not specified",
        "suggestion": "Ask about specific authentication flows (OAuth, credentials, etc.)"
      }
    ],
    "interactionPatterns": {
      "promptClarity": 8,
      "contextCompleteness": 7,
      "followUpEffectiveness": "good",
      "commonIssues": ["Missing version info", "Vague requirements"],
      "strengths": ["Clear intent", "Good questions"]
    },
    "technicalDetails": {
      "frameworks": ["Next.js", "NextAuth.js"],
      "issues": [],
      "solutions": ["Use NextAuth.js for authentication"]
    },
    "conversationQuality": {
      "clarity": "high",
      "completeness": "complete",
      "effectiveness": "highly effective"
    }
  }
}
\`\`\``

    const result = parseAnalysisResponse(validResponse)

    expect(result.summary).toBeDefined()
    expect(result.keyTopics).toBeArray()
    expect(result.sentiment).toBeOneOf(['positive', 'neutral', 'negative', 'mixed'])
    expect(result.conversationQuality.clarity).toBeOneOf(['high', 'medium', 'low'])
  })

  it('should handle response with extra whitespace', () => {
    const responseWithWhitespace = `
    
    \`\`\`json
    {
      "analysis": {
        "summary": "Test summary",
        "keyTopics": ["Topic 1"],
        "sentiment": "neutral",
        "userIntent": "Test intent",
        "outcomes": ["Outcome 1"],
        "actionItems": [{ "type": "task", "description": "Action 1", "priority": "medium" }],
        "promptingTips": [{ "category": "clarity", "issue": "Test issue", "suggestion": "Tip 1" }],
        "interactionPatterns": { "promptClarity": 5, "contextCompleteness": 5, "followUpEffectiveness": "needs_improvement", "commonIssues": [], "strengths": [] },
        "technicalDetails": { "frameworks": [], "issues": [], "solutions": [] },
        "conversationQuality": { "clarity": "medium", "completeness": "partial", "effectiveness": "effective" }
      }
    }
    \`\`\`
    
    `

    const result = parseAnalysisResponse(responseWithWhitespace)
    expect(result.summary).toBe('Test summary')
  })

  it('should throw error for invalid JSON', () => {
    const invalidJson = 'This is not JSON'

    expect(() => parseAnalysisResponse(invalidJson)).toThrow(
      'Failed to parse analysis response as JSON'
    )
  })

  it('should throw error for missing required fields', () => {
    const incompleteResponse = `\`\`\`json
{
  "analysis": {
    "summary": "Test summary"
  }
}
\`\`\``

    expect(() => parseAnalysisResponse(incompleteResponse)).toThrow(
      'Invalid analysis response format'
    )
  })

  it('should throw error for invalid enum values', () => {
    const invalidEnumResponse = `\`\`\`json
{
  "analysis": {
    "summary": "Test summary",
    "keyTopics": ["Topic 1"],
    "sentiment": "very positive",
    "userIntent": "Test intent",
    "outcomes": ["Outcome 1"],
    "actionItems": ["Action 1"],
    "technicalDetails": { "frameworks": [], "issues": [], "solutions": [] },
    "conversationQuality": { "clarity": "high", "completeness": "complete", "effectiveness": "highly effective" }
  }
}
\`\`\``

    expect(() => parseAnalysisResponse(invalidEnumResponse)).toThrow(
      'Invalid analysis response format'
    )
  })

  it('should validate nested objects correctly', () => {
    const invalidNestedResponse = `\`\`\`json
{
  "analysis": {
    "summary": "Test summary",
    "keyTopics": ["Topic 1"],
    "sentiment": "neutral",
    "userIntent": "Test intent",
    "outcomes": ["Outcome 1"],
    "actionItems": [{ "type": "task", "description": "Action 1", "priority": "low" }],
    "promptingTips": [{ "category": "clarity", "issue": "Test", "suggestion": "Tip" }],
    "interactionPatterns": { "promptClarity": 5, "contextCompleteness": 5, "followUpEffectiveness": "good", "commonIssues": [], "strengths": [] },
    "technicalDetails": {
      "frameworks": "Not an array",
      "issues": [],
      "solutions": []
    },
    "conversationQuality": { "clarity": "high", "completeness": "complete", "effectiveness": "highly effective" }
  }
}
\`\`\``

    expect(() => parseAnalysisResponse(invalidNestedResponse)).toThrow(
      'Invalid analysis response format'
    )
  })

  it('should accept all valid enum values', () => {
    const testEnumValues = {
      sentiment: ['positive', 'neutral', 'negative', 'mixed'],
      clarity: ['high', 'medium', 'low'],
      completeness: ['complete', 'partial', 'incomplete'],
      effectiveness: ['highly effective', 'effective', 'needs improvement'],
    }

    // Test each sentiment value
    testEnumValues.sentiment.forEach(sentiment => {
      const response = `\`\`\`json
{
  "analysis": {
    "summary": "Test",
    "keyTopics": ["Topic"],
    "sentiment": "${sentiment}",
    "userIntent": "Intent",
    "outcomes": ["Outcome"],
    "actionItems": [{ "type": "task", "description": "Action", "priority": "low" }],
    "promptingTips": [{ "category": "clarity", "issue": "Test", "suggestion": "Tip" }],
    "interactionPatterns": { "promptClarity": 5, "contextCompleteness": 5, "followUpEffectiveness": "good", "commonIssues": [], "strengths": [] },
    "technicalDetails": { "frameworks": [], "issues": [], "solutions": [] },
    "conversationQuality": { 
      "clarity": "high", 
      "completeness": "complete", 
      "effectiveness": "effective" 
    }
  }
}
\`\`\``

      expect(() => parseAnalysisResponse(response)).not.toThrow()
    })
  })
})
