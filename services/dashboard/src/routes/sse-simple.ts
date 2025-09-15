import { Context } from 'hono'

// Store active SSE connections
const connections = new Map<string, Set<(data: string) => void>>()

/**
 * Simple SSE handler that works with Node.js
 */
export async function handleSSE(c: Context) {
  // Set SSE headers
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no') // Disable nginx buffering

  const trainId = c.req.query('trainId') || 'global'

  // Create a stream
  const encoder = new TextEncoder()
  let intervalId: NodeJS.Timeout
  let send: ((data: string) => void) | undefined

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'connected',
            timestamp: new Date().toISOString(),
          })}\n\n`
        )
      )

      // Add connection to map
      send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch (_e) {
          // Connection closed
        }
      }

      if (!connections.has(domain)) {
        connections.set(trainId, new Set())
      }
      connections.get(domain)!.add(send)

      // Heartbeat to keep connection alive
      intervalId = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`:heartbeat\n\n`))
        } catch (_e) {
          clearInterval(intervalId)
        }
      }, 30000)
    },

    cancel() {
      // Clean up on disconnect
      clearInterval(intervalId)
      const domainConnections = connections.get(domain)
      if (domainConnections && send) {
        domainConnections.forEach(conn => {
          if (conn === send) {
            domainConnections.delete(conn)
          }
        })
      }
    },
  })

  return new Response(stream, {
    headers: c.res.headers,
  })
}

/**
 * Broadcast event to connections
 */
export function broadcastEvent(event: { type: string; trainId?: string; data: any }) {
  const message = JSON.stringify({
    type: event.type,
    data: event.data,
    timestamp: new Date().toISOString(),
  })

  // Send to domain-specific connections
  if (event.domain && connections.has(event.domain)) {
    connections.get(event.domain)!.forEach(send => {
      try {
        send(message)
      } catch (_e) {
        // Remove dead connection
        connections.get(event.domain!)!.delete(send)
      }
    })
  }

  // Also send to global connections
  if (connections.has('global')) {
    connections.get('global')!.forEach(send => {
      try {
        send(message)
      } catch (_e) {
        connections.get('global')!.delete(send)
      }
    })
  }
}

export function getSSEStats() {
  const stats: Record<string, number> = {}
  connections.forEach((conns, key) => {
    stats[key] = conns.size
  })
  return stats
}

// Re-export the broadcast functions from original
export { broadcastConversation, broadcastMetrics } from './sse'
