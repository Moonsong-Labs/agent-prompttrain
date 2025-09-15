import { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

// Store active SSE connections
const sseConnections = new Map<
  string,
  Set<{ write: (data: string) => Promise<void>; close: () => void }>
>()

/**
 * SSE endpoint for real-time dashboard updates
 */
export async function handleSSE(c: Context) {
  const trainId = c.req.query('trainId')
  const connectionId = crypto.randomUUID()

  return streamSSE(c, async stream => {
    // Add this connection to the active connections
    const key = domain || 'global'
    if (!sseConnections.has(key)) {
      sseConnections.set(key, new Set())
    }

    const connection = {
      write: async (data: string) => {
        try {
          await stream.writeSSE({ data })
        } catch (_e) {
          // Connection closed
        }
      },
      close: () => stream.close(),
    }

    sseConnections.get(key)!.add(connection)

    // Send initial connection message
    await stream.writeSSE({
      data: JSON.stringify({
        type: 'connected',
        connectionId,
        timestamp: new Date().toISOString(),
      }),
    })

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(async () => {
      try {
        await stream.writeSSE({ data: '', id: '', event: 'heartbeat' })
      } catch (_e) {
        // Connection closed
        clearInterval(heartbeat)
      }
    }, 30000) // Every 30 seconds

    // Clean up on disconnect
    const cleanup = () => {
      clearInterval(heartbeat)
      sseConnections.get(key)?.delete(connection)
      if (sseConnections.get(key)?.size === 0) {
        sseConnections.delete(key)
      }
    }

    // Handle client disconnect
    stream.onAbort(() => {
      cleanup()
    })

    // Keep the connection open by not returning
    // The connection stays open until client disconnects
  })
}

/**
 * Broadcast an event to all connected SSE clients
 */
export function broadcastEvent(event: { type: string; trainId?: string; data: any }) {
  const message = JSON.stringify({
    type: event.type,
    data: event.data,
    timestamp: new Date().toISOString(),
  })

  // Send to domain-specific connections
  if (event.domain && sseConnections.has(event.domain)) {
    sseConnections.get(event.domain)!.forEach(async connection => {
      try {
        await connection.write(message)
      } catch (_e) {
        // Remove dead connections
        sseConnections.get(event.domain!)!.delete(connection)
      }
    })
  }

  // Also send to global connections
  if (sseConnections.has('global')) {
    sseConnections.get('global')!.forEach(async connection => {
      try {
        await connection.write(message)
      } catch (_e) {
        // Remove dead connections
        sseConnections.get('global')!.delete(connection)
      }
    })
  }
}

/**
 * Broadcast conversation updates
 */
export function broadcastConversation(conversation: {
  id: string
  trainId: string
  model: string
  tokens: number
  timestamp: string
}) {
  broadcastEvent({
    type: 'conversation',
    trainId: conversation.trainId,
    data: conversation,
  })
}

/**
 * Broadcast metrics updates
 */
export function broadcastMetrics(metrics: {
  trainId?: string
  requests: number
  tokens: number
  activeUsers: number
}) {
  broadcastEvent({
    type: 'metrics',
    trainId: metrics.trainId,
    data: metrics,
  })
}

/**
 * Get connection stats
 */
export function getSSEStats() {
  const stats: Record<string, number> = {}
  sseConnections.forEach((connections, key) => {
    stats[key] = connections.size
  })
  return stats
}
