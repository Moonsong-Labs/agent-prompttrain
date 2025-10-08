import { faker } from '@faker-js/faker'

// Factory for creating test credentials
export const credentialFactory = {
  apiKey: (overrides = {}) => ({
    type: 'api_key' as const,
    api_key: faker.string.alphanumeric({ length: 40, prefix: 'sk-ant-api03-' }),
    ...overrides,
  }),

  oauth: (overrides = {}) => ({
    type: 'oauth' as const,
    oauth: {
      accessToken: faker.string.alphanumeric(64),
      refreshToken: faker.string.alphanumeric(64),
      expiresAt: Date.now() + faker.number.int({ min: 3600000, max: 7200000 }),
      scopes: ['user:inference', 'org:create_api_key'],
      isMax: faker.datatype.boolean(),
      ...overrides,
    },
  }),

  withSlack: (baseCredential: any, slackOverrides = {}) => ({
    ...baseCredential,
    slack: {
      webhook_url: faker.internet.url({ protocol: 'https' }),
      channel: faker.helpers.arrayElement(['#general', '#claude-logs', '#dev']),
      username: faker.internet.userName(),
      icon_emoji: faker.helpers.arrayElement([':robot_face:', ':claude:', ':bot:']),
      enabled: true,
      ...slackOverrides,
    },
  }),
}

// Factory for creating Claude API requests
export const requestFactory = {
  simple: (overrides = {}) => ({
    model: faker.helpers.arrayElement([
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ]),
    messages: [
      {
        role: 'user' as const,
        content: faker.lorem.sentence(),
      },
    ],
    max_tokens: faker.number.int({ min: 10, max: 1000 }),
    ...overrides,
  }),

  withSystem: (systemPrompt: string, overrides = {}) => ({
    model: 'claude-3-opus-20240229',
    system: systemPrompt,
    messages: [
      {
        role: 'user' as const,
        content: faker.lorem.sentence(),
      },
    ],
    max_tokens: 100,
    ...overrides,
  }),

  streaming: (overrides = {}) => ({
    ...requestFactory.simple(),
    stream: true,
    ...overrides,
  }),

  withTools: (overrides = {}) => ({
    ...requestFactory.simple(),
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
        },
      },
    ],
    ...overrides,
  }),

  conversation: (messageCount = 3) => {
    const messages = []
    for (let i = 0; i < messageCount; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: faker.lorem.paragraph(),
      })
    }
    // Ensure last message is from user
    if (messages[messages.length - 1].role === 'assistant') {
      messages.push({
        role: 'user',
        content: faker.lorem.sentence(),
      })
    }

    return {
      model: 'claude-3-opus-20240229',
      messages,
      max_tokens: 500,
    }
  },
}

// Factory for creating Claude API responses
export const responseFactory = {
  simple: (overrides = {}) => ({
    id: `msg_${faker.string.alphanumeric(10)}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: faker.lorem.paragraph(),
      },
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: faker.number.int({ min: 10, max: 1000 }),
      output_tokens: faker.number.int({ min: 10, max: 1000 }),
    },
    ...overrides,
  }),

  withToolUse: (overrides = {}) => ({
    ...responseFactory.simple(),
    content: [
      {
        type: 'text',
        text: "I'll help you with that.",
      },
      {
        type: 'tool_use',
        id: `toolu_${faker.string.alphanumeric(10)}`,
        name: 'get_weather',
        input: {
          location: faker.location.city(),
        },
      },
    ],
    ...overrides,
  }),

  error: (type: string, message: string, _status = 400) => ({
    error: {
      type,
      message,
    },
  }),

  streamChunks: {
    messageStart: (overrides = {}) => ({
      type: 'message_start',
      message: {
        id: `msg_${faker.string.alphanumeric(10)}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-3-opus-20240229',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: faker.number.int({ min: 10, max: 100 }),
          output_tokens: 0,
        },
        ...overrides,
      },
    }),

    contentBlockStart: (index = 0, blockType = 'text') => ({
      type: 'content_block_start',
      index,
      content_block: {
        type: blockType,
        text: blockType === 'text' ? '' : undefined,
        id: blockType === 'tool_use' ? `toolu_${faker.string.alphanumeric(10)}` : undefined,
        name: blockType === 'tool_use' ? 'get_weather' : undefined,
        input: blockType === 'tool_use' ? {} : undefined,
      },
    }),

    contentBlockDelta: (index = 0, text: string) => ({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text,
      },
    }),

    contentBlockStop: (index = 0) => ({
      type: 'content_block_stop',
      index,
    }),

    messageDelta: (outputTokens: number, stopReason = 'end_turn') => ({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens,
      },
    }),

    messageStop: () => ({
      type: 'message_stop',
    }),
  },
}

// Factory for creating test scenarios
export const scenarioFactory = {
  // Create a complete streaming response
  streamingResponse: (text: string, chunkSize = 20) => {
    const chunks = []
    const words = text.split(' ')

    // Message start
    chunks.push(responseFactory.streamChunks.messageStart())

    // Content block start
    chunks.push(responseFactory.streamChunks.contentBlockStart())

    // Content deltas
    let currentChunk = ''
    for (let i = 0; i < words.length; i++) {
      currentChunk += (currentChunk ? ' ' : '') + words[i]
      if (currentChunk.length >= chunkSize || i === words.length - 1) {
        chunks.push(responseFactory.streamChunks.contentBlockDelta(0, currentChunk))
        currentChunk = ''
      }
    }

    // Content block stop
    chunks.push(responseFactory.streamChunks.contentBlockStop())

    // Message delta with token count
    const outputTokens = Math.ceil(text.split(' ').length * 1.3)
    chunks.push(responseFactory.streamChunks.messageDelta(outputTokens))

    // Message stop
    chunks.push(responseFactory.streamChunks.messageStop())

    return chunks
  },

  // Create telemetry data
  telemetryData: (overrides = {}) => ({
    requestId: faker.string.uuid(),
    timestamp: Date.now(),
    projectId: `train-${faker.string.alphanumeric(8).toLowerCase()}`,
    apiKey: `sk-ant-api03-${faker.string.alphanumeric(8)}`,
    model: 'claude-3-opus-20240229',
    inputTokens: faker.number.int({ min: 10, max: 1000 }),
    outputTokens: faker.number.int({ min: 10, max: 1000 }),
    duration: faker.number.int({ min: 100, max: 5000 }),
    status: 200,
    ...overrides,
  }),
}

// Helper to create realistic conversation data
export function createConversation(config = {}) {
  const {
    messageCount = faker.number.int({ min: 2, max: 10 }),
    includeSystem = faker.datatype.boolean(),
    includeTools = faker.datatype.boolean(),
    model = 'claude-3-opus-20240229',
  } = config

  const messages = []

  // Add system message if requested
  if (includeSystem) {
    messages.push({
      role: 'system',
      content: faker.helpers.arrayElement([
        'You are a helpful assistant.',
        'You are an expert programmer.',
        'You are a creative writer.',
        'Answer concisely and accurately.',
      ]),
    })
  }

  // Generate conversation
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    messages.push({
      role,
      content:
        role === 'user'
          ? faker.helpers.arrayElement([
              faker.lorem.question(),
              faker.lorem.sentence(),
              `Can you help me with ${faker.hacker.phrase()}?`,
            ])
          : faker.lorem.paragraph({ min: 1, max: 3 }),
    })
  }

  // Ensure last message is from user
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({
      role: 'user',
      content: faker.lorem.sentence(),
    })
  }

  const request = {
    model,
    messages,
    max_tokens: faker.number.int({ min: 100, max: 1000 }),
  }

  if (includeTools) {
    request.tools = [
      {
        name: faker.helpers.arrayElement(['search_web', 'calculate', 'get_weather']),
        description: faker.lorem.sentence(),
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]
  }

  return request
}
