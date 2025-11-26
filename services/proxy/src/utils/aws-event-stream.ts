/**
 * AWS Event Stream Parser
 *
 * Parses the binary application/vnd.amazon.eventstream format used by
 * AWS services like Bedrock Runtime for streaming responses.
 *
 * Message format:
 * - 4 bytes: total message length (big-endian uint32)
 * - 4 bytes: headers length (big-endian uint32)
 * - 4 bytes: prelude CRC (uint32)
 * - variable: headers (key-value pairs with type indicators)
 * - variable: payload (the actual message content)
 * - 4 bytes: message CRC (uint32)
 *
 * @see https://smithy.io/2.0/aws/amazon-eventstream.html
 */

const PRELUDE_LENGTH = 12 // 4 + 4 + 4 bytes
const MESSAGE_CRC_LENGTH = 4

/**
 * Parsed event from AWS Event Stream
 */
export interface AwsEventStreamMessage {
  headers: Record<string, string | number | boolean | Uint8Array>
  payload: Uint8Array
}

/**
 * Parse AWS Event Stream messages from a buffer
 * Returns parsed messages and any remaining bytes that form incomplete messages
 */
export function parseAwsEventStreamMessages(buffer: Uint8Array<ArrayBuffer>): {
  messages: AwsEventStreamMessage[]
  remaining: Uint8Array<ArrayBuffer>
} {
  const messages: AwsEventStreamMessage[] = []
  let offset = 0

  while (offset + PRELUDE_LENGTH <= buffer.length) {
    // Read prelude
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset)
    const totalLength = view.getUint32(0, false) // big-endian
    const headersLength = view.getUint32(4, false) // big-endian

    // Check if we have the complete message
    if (offset + totalLength > buffer.length) {
      break // Incomplete message, wait for more data
    }

    // Skip prelude CRC validation for simplicity (4 bytes at offset 8)

    // Parse headers
    const headersStart = offset + PRELUDE_LENGTH
    const headers = parseHeaders(
      new Uint8Array(buffer.buffer, buffer.byteOffset + headersStart, headersLength)
    )

    // Extract payload
    const payloadStart = headersStart + headersLength
    const payloadLength = totalLength - PRELUDE_LENGTH - headersLength - MESSAGE_CRC_LENGTH
    const payload = new Uint8Array(buffer.buffer, buffer.byteOffset + payloadStart, payloadLength)

    // Skip message CRC validation for simplicity

    messages.push({ headers, payload })
    offset += totalLength
  }

  // Create a copy for remaining bytes to avoid holding reference to original buffer
  const remainingBytes = new Uint8Array(buffer.length - offset)
  remainingBytes.set(
    new Uint8Array(buffer.buffer, buffer.byteOffset + offset, buffer.length - offset)
  )

  return {
    messages,
    remaining: remainingBytes,
  }
}

/**
 * Parse headers section of AWS Event Stream message
 */
function parseHeaders(data: Uint8Array): Record<string, string | number | boolean | Uint8Array> {
  const headers: Record<string, string | number | boolean | Uint8Array> = {}
  let offset = 0

  while (offset < data.length) {
    // Header name length (1 byte)
    const nameLength = data[offset]
    offset += 1

    if (offset + nameLength > data.length) {
      break
    }

    // Header name
    const name = new TextDecoder().decode(data.slice(offset, offset + nameLength))
    offset += nameLength

    if (offset >= data.length) {
      break
    }

    // Header type (1 byte)
    const type = data[offset]
    offset += 1

    // Header value based on type
    let value: string | number | boolean | Uint8Array

    switch (type) {
      case 0: // bool_true
        value = true
        break
      case 1: // bool_false
        value = false
        break
      case 2: // byte
        value = data[offset]
        offset += 1
        break
      case 3: // short
        value = new DataView(data.buffer, data.byteOffset + offset).getInt16(0, false)
        offset += 2
        break
      case 4: // int
        value = new DataView(data.buffer, data.byteOffset + offset).getInt32(0, false)
        offset += 4
        break
      case 5: // long
        value = Number(new DataView(data.buffer, data.byteOffset + offset).getBigInt64(0, false))
        offset += 8
        break
      case 6: // bytes
        {
          const bytesLength = new DataView(data.buffer, data.byteOffset + offset).getUint16(
            0,
            false
          )
          offset += 2
          value = data.slice(offset, offset + bytesLength)
          offset += bytesLength
        }
        break
      case 7: // string
        {
          const stringLength = new DataView(data.buffer, data.byteOffset + offset).getUint16(
            0,
            false
          )
          offset += 2
          value = new TextDecoder().decode(data.slice(offset, offset + stringLength))
          offset += stringLength
        }
        break
      case 8: // timestamp
        value = Number(new DataView(data.buffer, data.byteOffset + offset).getBigInt64(0, false))
        offset += 8
        break
      case 9: // uuid
        value = data.slice(offset, offset + 16)
        offset += 16
        break
      default:
        // Unknown type, skip
        value = ''
    }

    headers[name] = value
  }

  return headers
}

/**
 * Create a TransformStream that parses AWS Event Stream and extracts JSON payloads
 * Each output chunk is a JSON string from the event payload
 */
export function createAwsEventStreamParser(): TransformStream<Uint8Array<ArrayBuffer>, string> {
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  const decoder = new TextDecoder()

  return new TransformStream({
    transform(chunk, controller) {
      // Concatenate with existing buffer
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer

      // Parse complete messages
      const { messages, remaining } = parseAwsEventStreamMessages(buffer)
      buffer = remaining

      // Output JSON payloads
      for (const message of messages) {
        // Check if this is a chunk event (vs error, etc.)
        const eventType = message.headers[':event-type']
        if (eventType === 'chunk') {
          const payloadStr = decoder.decode(message.payload)
          // The payload contains a JSON object with a "bytes" field that is base64 encoded
          try {
            const payloadObj = JSON.parse(payloadStr) as { bytes?: string }
            if (payloadObj.bytes) {
              // Decode base64 to get the actual Claude response JSON
              const decodedBytes = atob(payloadObj.bytes)
              controller.enqueue(decodedBytes)
            }
          } catch {
            // If not the expected format, try using payload directly
            controller.enqueue(payloadStr)
          }
        }
      }
    },

    flush(controller) {
      // Process any remaining data
      if (buffer.length > 0) {
        const { messages } = parseAwsEventStreamMessages(buffer)
        const decoder = new TextDecoder()
        for (const message of messages) {
          const eventType = message.headers[':event-type']
          if (eventType === 'chunk') {
            const payloadStr = decoder.decode(message.payload)
            try {
              const payloadObj = JSON.parse(payloadStr) as { bytes?: string }
              if (payloadObj.bytes) {
                const decodedBytes = atob(payloadObj.bytes)
                controller.enqueue(decodedBytes)
              }
            } catch {
              controller.enqueue(payloadStr)
            }
          }
        }
      }
    },
  })
}
