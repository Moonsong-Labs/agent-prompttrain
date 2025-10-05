/**
 * API endpoints for credential management
 *
 * Provides REST API for CRUD operations on accounts and trains.
 * Database credentials are always enabled (ADR-026).
 */

import { Hono } from 'hono'
import { container } from '../container.js'
import { CredentialsRepository, getErrorMessage, generateApiKey } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export const credentialsApiRoutes = new Hono()

function getRepository(): CredentialsRepository {
  const pool = container.getPool()
  return new CredentialsRepository(pool)
}

// ========================================
// ACCOUNTS API
// ========================================

/**
 * GET /accounts - List all accounts
 */
credentialsApiRoutes.get('/accounts', async c => {
  try {
    const repo = getRepository()
    const accounts = await repo.listAccounts()

    return c.json({
      status: 'ok',
      accounts,
      count: accounts.length,
    })
  } catch (error) {
    logger.error('Failed to list accounts', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve accounts' }, 500)
  }
})

/**
 * GET /accounts/:id - Get a single account
 */
credentialsApiRoutes.get('/accounts/:id', async c => {
  try {
    const accountId = c.req.param('id')
    const repo = getRepository()
    const account = await repo.getAccountById(accountId)

    if (!account) {
      return c.json({ error: 'Account not found' }, 404)
    }

    return c.json({
      status: 'ok',
      account,
    })
  } catch (error) {
    logger.error('Failed to get account', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve account' }, 500)
  }
})

/**
 * POST /accounts - Create a new account
 */
credentialsApiRoutes.post('/accounts', async c => {
  try {
    const body = await c.req.json()

    // Validate required fields
    if (!body.accountName || !body.credentialType) {
      return c.json({ error: 'accountName and credentialType are required' }, 400)
    }

    if (body.credentialType === 'api_key' && !body.apiKey) {
      return c.json({ error: 'apiKey is required for API key credentials' }, 400)
    }

    if (body.credentialType === 'oauth' && (!body.oauthAccessToken || !body.oauthRefreshToken)) {
      return c.json(
        { error: 'oauthAccessToken and oauthRefreshToken are required for OAuth credentials' },
        400
      )
    }

    const repo = getRepository()
    const accountId = await repo.createAccount(body)

    logger.info('Account created', { metadata: { accountId, accountName: body.accountName } })

    return c.json(
      {
        status: 'ok',
        accountId,
      },
      201
    )
  } catch (error) {
    logger.error('Failed to create account', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to create account' }, 500)
  }
})

/**
 * PUT /accounts/:id - Update an account
 */
credentialsApiRoutes.put('/accounts/:id', async c => {
  try {
    const accountId = c.req.param('id')
    const body = await c.req.json()

    const repo = getRepository()

    // Check if account exists
    const existing = await repo.getAccountById(accountId)
    if (!existing) {
      return c.json({ error: 'Account not found' }, 404)
    }

    await repo.updateAccount(accountId, body)

    logger.info('Account updated', { metadata: { accountId } })

    return c.json({
      status: 'ok',
    })
  } catch (error) {
    logger.error('Failed to update account', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to update account' }, 500)
  }
})

/**
 * DELETE /accounts/:id - Delete an account
 */
credentialsApiRoutes.delete('/accounts/:id', async c => {
  try {
    const accountId = c.req.param('id')

    const repo = getRepository()

    // Check if account exists
    const existing = await repo.getAccountById(accountId)
    if (!existing) {
      return c.json({ error: 'Account not found' }, 404)
    }

    await repo.deleteAccount(accountId)

    logger.info('Account deleted', { metadata: { accountId } })

    return c.json({
      status: 'ok',
    })
  } catch (error) {
    logger.error('Failed to delete account', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to delete account' }, 500)
  }
})

// ========================================
// TRAINS API
// ========================================

/**
 * GET /trains - List all trains
 */
credentialsApiRoutes.get('/trains', async c => {
  try {
    const repo = getRepository()
    const trains = await repo.listTrains()

    return c.json({
      status: 'ok',
      trains,
      count: trains.length,
    })
  } catch (error) {
    logger.error('Failed to list trains', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve trains' }, 500)
  }
})

/**
 * GET /trains/:id - Get a single train
 */
credentialsApiRoutes.get('/trains/:id', async c => {
  try {
    const trainId = c.req.param('id')
    const repo = getRepository()
    const train = await repo.getTrainById(trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    return c.json({
      status: 'ok',
      train,
    })
  } catch (error) {
    logger.error('Failed to get train', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve train' }, 500)
  }
})

/**
 * POST /trains - Create a new train
 */
credentialsApiRoutes.post('/trains', async c => {
  try {
    const body = await c.req.json()

    // Validate required fields
    if (!body.trainId) {
      return c.json({ error: 'trainId is required' }, 400)
    }

    const repo = getRepository()
    await repo.createTrain(body.trainId, body)

    logger.info('Train created', { metadata: { trainId: body.trainId } })

    return c.json(
      {
        status: 'ok',
        trainId: body.trainId,
      },
      201
    )
  } catch (error) {
    logger.error('Failed to create train', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to create train' }, 500)
  }
})

/**
 * PUT /trains/:id - Update a train
 */
credentialsApiRoutes.put('/trains/:id', async c => {
  try {
    const trainId = c.req.param('id')
    const body = await c.req.json()

    const repo = getRepository()

    // Check if train exists
    const existing = await repo.getTrainById(trainId)
    if (!existing) {
      return c.json({ error: 'Train not found' }, 404)
    }

    await repo.updateTrain(trainId, body)

    logger.info('Train updated', { metadata: { trainId } })

    return c.json({
      status: 'ok',
    })
  } catch (error) {
    logger.error('Failed to update train', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to update train' }, 500)
  }
})

/**
 * DELETE /trains/:id - Delete a train
 */
credentialsApiRoutes.delete('/trains/:id', async c => {
  try {
    const trainId = c.req.param('id')

    const repo = getRepository()

    // Check if train exists
    const existing = await repo.getTrainById(trainId)
    if (!existing) {
      return c.json({ error: 'Train not found' }, 404)
    }

    await repo.deleteTrain(trainId)

    logger.info('Train deleted', { metadata: { trainId } })

    return c.json({
      status: 'ok',
    })
  } catch (error) {
    logger.error('Failed to delete train', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to delete train' }, 500)
  }
})

// ========================================
// API KEY GENERATION & REVOCATION
// ========================================

/**
 * POST /accounts/generate - Generate a new API key for a train
 */
credentialsApiRoutes.post('/accounts/generate', async c => {
  try {
    const body = await c.req.json()

    // Validate required fields
    if (!body.trainId || !body.accountName) {
      return c.json({ error: 'trainId and accountName are required' }, 400)
    }

    const repo = getRepository()

    // Check per-train limit (10 keys per train)
    const perTrainCount = await repo.countGeneratedKeysForTrain(body.trainId)
    if (perTrainCount >= 10) {
      return c.json(
        {
          error: 'Per-train limit reached',
          message: 'Maximum of 10 generated API keys per train',
        },
        429
      )
    }

    // Check global limit (50 keys total)
    const globalCount = await repo.countGeneratedKeysGlobal()
    if (globalCount >= 50) {
      return c.json(
        {
          error: 'Global limit reached',
          message: 'Maximum of 50 generated API keys globally',
        },
        429
      )
    }

    // Generate the key
    const generatedKey = generateApiKey()

    // Store it
    const result = await repo.generateApiKeyForTrain(body.trainId, body.accountName, generatedKey)

    logger.info('API key generated', {
      metadata: {
        accountId: result.accountId,
        trainId: body.trainId,
        accountName: body.accountName,
      },
    })

    // Return the plaintext key (ONLY TIME IT WILL BE EXPOSED)
    return c.json(
      {
        status: 'ok',
        account_id: result.accountId,
        api_key: result.apiKey,
        warning: 'Save this key securely. You will not be able to see it again.',
      },
      201
    )
  } catch (error) {
    logger.error('Failed to generate API key', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to generate API key' }, 500)
  }
})

/**
 * PATCH /accounts/:id/revoke - Revoke an API key
 */
credentialsApiRoutes.patch('/accounts/:id/revoke', async c => {
  try {
    const accountId = c.req.param('id')

    const repo = getRepository()

    // Check if account exists
    const existing = await repo.getAccountById(accountId)
    if (!existing) {
      return c.json({ error: 'Account not found' }, 404)
    }

    await repo.revokeAccount(accountId)

    logger.info('Account revoked', { metadata: { accountId } })

    return c.json({
      status: 'ok',
      message: 'Account revoked successfully',
    })
  } catch (error) {
    logger.error('Failed to revoke account', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to revoke account' }, 500)
  }
})

/**
 * GET /trains/:id/accounts - Get all accounts for a specific train
 */
credentialsApiRoutes.get('/trains/:id/accounts', async c => {
  try {
    const trainId = c.req.param('id')

    const repo = getRepository()

    // Check if train exists
    const train = await repo.getTrainById(trainId)
    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const accounts = await repo.getAccountsForTrain(trainId)

    return c.json({
      status: 'ok',
      accounts,
      count: accounts.length,
    })
  } catch (error) {
    logger.error('Failed to get train accounts', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve train accounts' }, 500)
  }
})
