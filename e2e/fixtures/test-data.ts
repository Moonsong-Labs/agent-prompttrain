export const testData = {
  // Sample API request data
  sampleRequest: {
    id: 'test-request-001',
    request_type: 'inference',
    model: 'claude-3-opus',
    projectId: 'train-e2e',
    status_code: 200,
    created_at: new Date().toISOString(),
    response_time_ms: 1234,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    conversation_id: 'test-conv-001',
    branch_id: 'main',
  },

  // Sample conversation data
  sampleConversation: {
    id: 'test-conv-001',
    messages: [
      {
        role: 'user',
        content: 'Test user message',
      },
      {
        role: 'assistant',
        content: 'Test assistant response',
      },
    ],
    created_at: new Date().toISOString(),
    request_count: 2,
  },

  // Token usage data
  tokenUsage: {
    daily: [
      { date: '2024-01-01', input_tokens: 1000, output_tokens: 2000 },
      { date: '2024-01-02', input_tokens: 1500, output_tokens: 2500 },
      { date: '2024-01-03', input_tokens: 2000, output_tokens: 3000 },
    ],
    current_window: {
      input_tokens: 5000,
      output_tokens: 10000,
      total_tokens: 15000,
      window_start: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
    },
  },

  // Prompt data for MCP
  samplePrompt: {
    name: 'test-prompt',
    description: 'Test prompt for e2e testing',
    template: 'You are {{role}}. Please {{action}}.',
    variables: {
      role: 'a helpful assistant',
      action: 'help the user',
    },
  },

  // Dashboard routes to test
  dashboardRoutes: [
    { path: '/', name: 'Dashboard Home' },
    { path: '/dashboard', name: 'Main Dashboard' },
    { path: '/requests', name: 'Requests' },
    { path: '/token-usage', name: 'Token Usage' },
    { path: '/prompts', name: 'Prompts' },
  ],

  // Critical user journeys
  userJourneys: {
    viewRequestDetails: {
      name: 'View Request Details',
      steps: [
        'Navigate to dashboard',
        'Click on requests tab',
        'Select a request from list',
        'View request details',
        'Check response data',
      ],
    },
    checkTokenUsage: {
      name: 'Check Token Usage',
      steps: [
        'Navigate to dashboard',
        'Click on token usage tab',
        'View current window usage',
        'Check daily chart',
        'Verify totals',
      ],
    },
    navigateConversation: {
      name: 'Navigate Conversation',
      steps: [
        'Navigate to dashboard',
        'Find conversation in list',
        'Click on conversation',
        'View conversation tree',
        'Check message flow',
      ],
    },
    viewAnalysis: {
      name: 'View AI Analysis',
      steps: [
        'Navigate to request with analysis',
        'Check analysis panel',
        'View analysis results',
        'Check for errors',
      ],
    },
    searchRequests: {
      name: 'Search and Filter Requests',
      steps: [
        'Navigate to requests page',
        'Enter search query',
        'Apply filters',
        'Sort results',
        'Verify filtered data',
      ],
    },
  },

  // Test environment config
  testConfig: {
    baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3001',
    apiKey: process.env.DASHBOARD_API_KEY || 'test_dashboard_key',
    defaultTimeout: 30000,
    retries: 1,
  },
}
