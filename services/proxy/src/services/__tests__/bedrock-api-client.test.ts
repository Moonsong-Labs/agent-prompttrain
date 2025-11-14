import { describe, it, expect, beforeEach } from 'bun:test'
import { BedrockApiClient } from '../BedrockApiClient'
import { ProxyResponse } from '../../domain/entities/ProxyResponse'

describe('BedrockApiClient', () => {
  let client: BedrockApiClient

  beforeEach(() => {
    client = new BedrockApiClient({
      region: 'us-east-1',
      timeout: 60000,
    })
  })

  describe('processResponse', () => {
    it('should process empty response without throwing error', async () => {
      const emptyResponse = {
        id: '',
        role: 'assistant' as const,
        type: 'message' as const,
        model: '',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        content: [],
        stop_reason: null,
        stop_sequence: null,
      }

      const mockResponse = new Response(JSON.stringify(emptyResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      const proxyResponse = new ProxyResponse('test-request-id', false)

      const result = await client.processResponse(mockResponse, proxyResponse)
      expect(result).toEqual(emptyResponse)
    })

    it('should process response with zero tokens and empty content', async () => {
      const emptyResponse = {
        id: '',
        role: 'assistant' as const,
        type: 'message' as const,
        model: '',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        content: [],
        stop_reason: null,
        stop_sequence: null,
      }

      const mockResponse = new Response(JSON.stringify(emptyResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      const proxyResponse = new ProxyResponse('test-request-id', false)

      const result = await client.processResponse(mockResponse, proxyResponse)
      expect(result).toEqual(emptyResponse)
    })

    it('should process valid response with content successfully', async () => {
      const validResponse = {
        id: 'msg-123',
        role: 'assistant' as const,
        type: 'message' as const,
        model: 'claude-3-sonnet',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
        content: [
          {
            type: 'text' as const,
            text: 'Hello, world!',
          },
        ],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
      }

      const mockResponse = new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      const proxyResponse = new ProxyResponse('test-request-id', false)

      const result = await client.processResponse(mockResponse, proxyResponse)

      expect(result).toEqual(validResponse)
      expect(result.content).toHaveLength(1)
      expect(result.usage.output_tokens).toBe(20)
    })

    it('should process valid response with empty content but valid usage', async () => {
      const validResponse = {
        id: 'msg-123',
        role: 'assistant' as const,
        type: 'message' as const,
        model: 'claude-3-sonnet',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
        content: [],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
      }

      const mockResponse = new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      const proxyResponse = new ProxyResponse('test-request-id', false)

      const result = await client.processResponse(mockResponse, proxyResponse)

      expect(result).toEqual(validResponse)
      expect(result.usage.output_tokens).toBe(5)
    })

    it('should process valid response with content but zero usage tokens', async () => {
      const validResponse = {
        id: 'msg-123',
        role: 'assistant' as const,
        type: 'message' as const,
        model: 'claude-3-sonnet',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        content: [
          {
            type: 'text' as const,
            text: 'Some content',
          },
        ],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
      }

      const mockResponse = new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

      const proxyResponse = new ProxyResponse('test-request-id', false)

      const result = await client.processResponse(mockResponse, proxyResponse)

      expect(result).toEqual(validResponse)
      expect(result.content).toHaveLength(1)
    })
  })
})
