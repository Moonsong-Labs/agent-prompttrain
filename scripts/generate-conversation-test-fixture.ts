#!/usr/bin/env bun

import { Pool } from 'pg'
import { config } from 'dotenv'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
// Removed imports for ConversationLinker and hashSystemPrompt as hashes are now taken directly from DB

// Load environment variables
config()

const __dirname = dirname(fileURLToPath(import.meta.url))

interface RequestData {
  request_id: string
  project_id: string
  conversation_id: string | null
  branch_id: string | null
  current_message_hash: string | null
  parent_message_hash: string | null
  system_hash: string | null
  headers: any
  body: any
  response_body: any
  response_headers: any
}

interface TestFixture {
  description: string
  type: 'standard' | 'compact'
  expectedLink: boolean
  expectedSummaryContent?: string
  expectedBranchPattern?: string
  parent: {
    request_id: string
    projectId: string
    conversation_id: string | null
    branch_id: string | null
    current_message_hash: string | null
    parent_message_hash: string | null
    system_hash: string | null
    body: any // Include full request body for test validation
    response_body: any
  }
  child: {
    request_id: string
    projectId: string
    body: any
  }
}

async function fetchRequestData(pool: Pool, requestId: string): Promise<RequestData | null> {
  const query = `
    SELECT 
      request_id,
      project_id,
      conversation_id,
      branch_id,
      current_message_hash,
      parent_message_hash,
      system_hash,
      headers,
      body,
      response_body,
      response_headers
    FROM api_requests
    WHERE request_id = $1
  `

  const result = await pool.query(query, [requestId])

  if (result.rows.length === 0) {
    return null
  }

  return result.rows[0]
}

function detectFixtureType(childBody: any): 'standard' | 'compact' {
  if (!childBody.messages || childBody.messages.length === 0) {
    return 'standard'
  }

  const firstMessage = childBody.messages[0]

  // Check all content items in the first message
  if (typeof firstMessage.content === 'string') {
    if (
      firstMessage.content.includes('This session is being continued from a previous conversation')
    ) {
      return 'compact'
    }
  } else if (Array.isArray(firstMessage.content)) {
    for (const item of firstMessage.content) {
      if (
        item.type === 'text' &&
        item.text.includes('This session is being continued from a previous conversation')
      ) {
        return 'compact'
      }
    }
  }

  return 'standard'
}

function extractSummaryContent(childBody: any): string | undefined {
  if (!childBody.messages || childBody.messages.length === 0) {
    return undefined
  }

  const firstMessage = childBody.messages[0]

  // Check all content items for the summary
  let fullContent = ''
  if (typeof firstMessage.content === 'string') {
    fullContent = firstMessage.content
  } else if (Array.isArray(firstMessage.content)) {
    fullContent = firstMessage.content
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n')
  }

  // Just return the raw content after the marker - no normalization
  // The test will handle the normalization comparison
  const markerIndex = fullContent.indexOf('The conversation is summarized below:')
  if (markerIndex > -1) {
    const startIndex = markerIndex + 'The conversation is summarized below:'.length
    return fullContent.substring(startIndex).trim()
  }

  return undefined
}

function generateBranchPattern(branchId: string | null): string | undefined {
  if (!branchId || branchId === 'main') {
    return undefined
  }

  // Common branch patterns
  if (branchId.startsWith('compact_')) {
    // The compact branch format is compact_HHMMSS (6 digits)
    return '^compact_\\d{6}$' // Fixed: removed extra backslashes
  }
  if (branchId.startsWith('branch_')) {
    return '^branch_\\d+$' // Fixed: removed extra backslashes
  }

  return undefined
}

async function generateTestFixture(
  pool: Pool,
  parentId: string,
  childId: string,
  description?: string
): Promise<TestFixture> {
  // Fetch both requests
  const [parentData, childData] = await Promise.all([
    fetchRequestData(pool, parentId),
    fetchRequestData(pool, childId),
  ])

  if (!parentData) {
    throw new Error(`Parent request ${parentId} not found`)
  }

  if (!childData) {
    throw new Error(`Child request ${childId} not found`)
  }

  // Filter out tools field from bodies to reduce fixture size
  const filterToolsField = (body: any) => {
    if (!body) return body

    const filtered = { ...body }
    // Remove the tools field which can be very large
    delete filtered.tools
    return filtered
  }

  // Sanitize sensitive data
  const sanitizeData = (data: any): any => {
    if (!data) return data

    // Deep clone to avoid modifying original
    const sanitized = JSON.parse(JSON.stringify(data))

    // Remove sensitive headers if present
    if (sanitized.headers) {
      if (sanitized.headers.authorization) {
        sanitized.headers.authorization = 'Bearer sk-ant-***'
      }
      if (sanitized.headers['x-api-key']) {
        sanitized.headers['x-api-key'] = '***'
      }
      if (sanitized.headers['anthropic-dangerous-direct-browser-access']) {
        sanitized.headers['anthropic-dangerous-direct-browser-access'] = 'true'
      }
    }

    // Sanitize API keys in body if present
    if (sanitized.api_key) {
      sanitized.api_key = 'sk-ant-***'
    }

    return sanitized
  }

  // Filter and sanitize bodies
  const parentBody = sanitizeData(filterToolsField(parentData.body))
  const childBody = sanitizeData(filterToolsField(childData.body))

  // Detect fixture type
  const fixtureType = detectFixtureType(childData.body)

  // Build the fixture
  const fixture: TestFixture = {
    description: description || `Test linking between ${parentId} and ${childId}`,
    type: fixtureType,
    expectedLink: childData.conversation_id === parentData.conversation_id,
    parent: {
      request_id: parentData.request_id,
      projectId: parentData.project_id,
      conversation_id: parentData.conversation_id,
      branch_id: parentData.branch_id,
      current_message_hash: parentData.current_message_hash,
      parent_message_hash: parentData.parent_message_hash,
      system_hash: parentData.system_hash,
      body: parentBody,
      response_body: sanitizeData(parentData.response_body),
    },
    child: {
      request_id: childData.request_id,
      projectId: childData.project_id,
      body: childBody,
    },
  }

  // Add optional fields for compact conversations
  if (fixtureType === 'compact') {
    const summaryContent = extractSummaryContent(childData.body)
    if (summaryContent) {
      fixture.expectedSummaryContent = summaryContent
    }

    const branchPattern = generateBranchPattern(childData.branch_id)
    if (branchPattern) {
      fixture.expectedBranchPattern = branchPattern
    }
  }

  return fixture
}

async function main() {
  const parentId = process.argv[2]
  const childId = process.argv[3]
  const outputFile = process.argv[4]
  const description = process.argv[5]

  if (!parentId || !childId) {
    console.error(
      'Usage: bun scripts/generate-conversation-test-fixture.ts <parent_request_id> <child_request_id> [output_file] [description]'
    )
    console.error('\nExample:')
    console.error('  bun scripts/generate-conversation-test-fixture.ts abc-123 def-456')
    console.error(
      '  bun scripts/generate-conversation-test-fixture.ts abc-123 def-456 my-test.json "Test branch creation"'
    )
    process.exit(1)
  }

  // Connect to database
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log(`Fetching requests ${parentId} and ${childId}...`)

    // Generate the test fixture
    const fixture = await generateTestFixture(pool, parentId, childId, description)

    // Determine output path
    let outputPath: string
    if (outputFile) {
      if (outputFile.startsWith('/')) {
        outputPath = outputFile
      } else {
        outputPath = join(
          __dirname,
          '..',
          'packages/shared/src/utils/__tests__/fixtures/conversation-linking',
          outputFile.endsWith('.json') ? outputFile : `${outputFile}.json`
        )
      }
    } else {
      // Generate a filename based on the request IDs
      const timestamp = new Date().toISOString().split('T')[0]
      outputPath = join(
        __dirname,
        '..',
        'packages/shared/src/utils/__tests__/fixtures/conversation-linking',
        `generated-${timestamp}-${parentId.slice(0, 8)}-${childId.slice(0, 8)}.json`
      )
    }

    // Ensure directory exists
    const dir = dirname(outputPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // Write the fixture
    await writeFile(outputPath, JSON.stringify(fixture, null, 2))

    console.log(`✅ Test fixture generated successfully!`)
    console.log(`📄 Output: ${outputPath}`)
    console.log(`🔗 Type: ${fixture.type}`)
    console.log(`✓ Expected link: ${fixture.expectedLink}`)

    if (fixture.expectedSummaryContent) {
      console.log(`📝 Summary content: "${fixture.expectedSummaryContent}"`)
    }

    // Display some key information
    console.log('\nFixture summary:')
    console.log(`- Parent conversation: ${fixture.parent.conversation_id || 'none'}`)
    console.log(`- Parent branch: ${fixture.parent.branch_id || 'none'}`)
    console.log(
      `- Parent message hash: ${fixture.parent.current_message_hash?.slice(0, 12) || 'none'}...`
    )
    console.log(`- Child messages: ${fixture.child.body.messages?.length || 0}`)
  } catch (error) {
    console.error('Error generating test fixture:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
