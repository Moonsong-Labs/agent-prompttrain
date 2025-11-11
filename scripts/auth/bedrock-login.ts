#!/usr/bin/env bun
import { Pool } from 'pg'

const BEDROCK_API_KEY_URL =
  'https://us-east-1.console.aws.amazon.com/bedrock/home?region=us-east-1#/api-keys/long-term/create'
const DEFAULT_REGION = 'us-east-1'

async function promptInput(question: string): Promise<string> {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function createBedrockCredential(
  pool: Pool,
  data: {
    account_id: string
    account_name: string
    aws_api_key: string
    aws_region: string
  }
): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Check if account_id already exists
    const existing = await client.query('SELECT id FROM credentials WHERE account_id = $1', [
      data.account_id,
    ])

    if (existing.rows.length > 0) {
      throw new Error(`Account ID '${data.account_id}' already exists`)
    }

    // Insert new Bedrock credential
    const result = await client.query(
      `INSERT INTO credentials (
        account_id, account_name, provider,
        aws_api_key, aws_region
      ) VALUES ($1, $2, 'bedrock', $3, $4)
      RETURNING id, account_id, account_name, provider, aws_region, created_at`,
      [data.account_id, data.account_name, data.aws_api_key, data.aws_region]
    )

    await client.query('COMMIT')

    console.log(`\n✅ Bedrock credentials saved successfully!`)
    console.log(`   Account ID: ${result.rows[0].account_id}`)
    console.log(`   Account Name: ${result.rows[0].account_name}`)
    console.log(`   Provider: ${result.rows[0].provider}`)
    console.log(`   Region: ${result.rows[0].aws_region}`)
    console.log(`   Created At: ${result.rows[0].created_at}`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function performBedrockLogin(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting Bedrock credential setup...\n')
    console.log('First, generate a long-term API key from AWS Bedrock:')
    console.log(BEDROCK_API_KEY_URL)
    console.log('\n')

    // Get account details
    const accountId = await promptInput('Enter account ID (e.g., acc_bedrock_prod): ')
    const accountName = await promptInput('Enter account name (e.g., Bedrock Production): ')

    if (!accountId || !accountName) {
      console.error('Account ID and name are required')
      process.exit(1)
    }

    // Get AWS API key
    const awsApiKey = await promptInput('Enter AWS Bedrock API key: ')
    if (!awsApiKey) {
      console.error('AWS API key is required')
      process.exit(1)
    }

    // Get AWS region (optional, defaults to us-east-1)
    const awsRegion =
      (await promptInput(`Enter AWS region (default: ${DEFAULT_REGION}): `)) || DEFAULT_REGION

    // Save to database
    console.log('\nSaving credentials to database...')
    await createBedrockCredential(pool, {
      account_id: accountId,
      account_name: accountName,
      aws_api_key: awsApiKey,
      aws_region: awsRegion,
    })

    console.log('\nNext steps:')
    console.log('1. Create or update a project via the dashboard')
    console.log('2. Link this Bedrock credential to the project')
    console.log('3. Generate API keys for the project')
  } catch (err) {
    console.error('Bedrock credential setup failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

performBedrockLogin()
