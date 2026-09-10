import { Pool } from 'pg'
import { join } from 'node:path'
import { up as addProjectApiKeys } from '../db/migrations/016-project-api-keys'

// Use only an explicitly selected, empty test database. Never load a developer's DATABASE_URL.
const databaseUrl = process.env.E2E_DATABASE_URL
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('E2E_DATABASE_URL must name an empty database ending in _test')
}

const root = join(import.meta.dir, '../..')
const pool = new Pool({ connectionString: databaseUrl })
try {
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  if (tables.rowCount) {
    throw new Error('E2E database is not empty; create a fresh test database')
  }

  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  // The production bootstrap already includes migrations 001–011.
  await pool.query(await Bun.file(join(root, 'scripts/init-database.sql')).text())
  const migrations = Array.from(new Bun.Glob('*.ts').scanSync(join(root, 'scripts/db/migrations')))
    .filter(file => parseInt(file, 10) >= 12)
    .sort()
  for (const migration of migrations) {
    console.log(`Applying ${migration}`)
    // Migration 016 exports up/down rather than exposing a CLI entry point.
    if (migration === '016-project-api-keys.ts') {
      await addProjectApiKeys(pool)
      continue
    }
    const child = Bun.spawn(['bun', join(root, 'scripts/db/migrations', migration)], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await child.exited) !== 0) {
      throw new Error(`Migration failed: ${migration}`)
    }
  }

  await pool.query(`
    INSERT INTO credentials (id, account_id, account_name, provider, aws_api_key)
    VALUES ('00000000-0000-4000-8000-000000000004', 'e2e-account', 'E2E Account', 'bedrock', 'e2e-unused-key');
    INSERT INTO projects (id, project_id, name, api_key)
    VALUES ('00000000-0000-4000-8000-000000000001', 'project-e2e', 'E2E Project', 'e2e-unused-key');
    INSERT INTO project_accounts (project_id, credential_id)
    VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004');
    INSERT INTO project_members (project_id, user_email, role, added_by)
    VALUES ('00000000-0000-4000-8000-000000000001', 'test@ci.localhost', 'owner', 'e2e');
    INSERT INTO api_requests (
      request_id, project_id, timestamp, method, path, headers, body, model,
      request_type, response_status, response_body, input_tokens, output_tokens,
      total_tokens, duration_ms, conversation_id, branch_id, message_count, account_id
    ) VALUES (
      '00000000-0000-4000-8000-000000000002', 'project-e2e', NOW(), 'POST', '/v1/messages', '{}',
      '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"E2E test message"}]}',
      'claude-sonnet-4-5', 'inference', 200,
      '{"role":"assistant","content":[{"type":"text","text":"E2E test response"}]}',
      100, 200, 300, 1234, '00000000-0000-4000-8000-000000000003', 'main', 1, 'e2e-account'
    );
    INSERT INTO conversation_analyses (
      conversation_id, branch_id, status, analysis_content, completed_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000003', 'main', 'completed',
      'E2E analysis: the assistant answered the test message.', NOW()
    );
  `)
  console.log('E2E database initialized with synthetic data')
} finally {
  await pool.end()
}
