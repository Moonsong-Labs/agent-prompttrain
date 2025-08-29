/**
 * MCP (Model Context Protocol) Server implementation
 */

import {
  MCP_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type InitializeParams,
  type InitializeResult,
  type ListPromptsParams,
  type ListPromptsResult,
  type GetPromptResult,
} from './types/protocol.js'
import type { PromptRegistryService } from './PromptRegistryService.js'

export class McpServer {
  private readonly serverInfo = {
    name: 'agent-prompttrain-mcp-server',
    version: '1.0.0',
  }

  private readonly protocolVersion = '2024-11-05'

  constructor(private promptRegistry: PromptRegistryService) {}

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request)

      case 'prompts/list':
        return this.handleListPrompts(request)

      case 'prompts/get':
        return this.handleGetPrompt(request)

      default:
        throw {
          code: MCP_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        }
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const _params = request.params as InitializeParams | undefined

    const result: InitializeResult = {
      protocolVersion: this.protocolVersion,
      capabilities: {
        prompts: {
          listPrompts: true,
          getPrompt: true,
        },
      },
      serverInfo: this.serverInfo,
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result,
    }
  }

  private async handleListPrompts(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const _params = request.params as ListPromptsParams | undefined

    try {
      const prompts = this.promptRegistry.listPrompts()

      const result: ListPromptsResult = {
        prompts: prompts.map(p => ({
          id: p.promptId,
          name: p.name,
          description: p.description,
          // No arguments in the new system
        })),
      }

      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      }
    } catch (error) {
      console.error('Error listing prompts:', error)
      throw {
        code: MCP_ERRORS.INTERNAL_ERROR,
        message: 'Failed to list prompts',
      }
    }
  }

  private async handleGetPrompt(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as Record<string, unknown>

    // Debug logging to understand what Claude Code is sending
    if (process.env.DEBUG) {
      console.error('[MCP] handleGetPrompt request:', JSON.stringify(request, null, 2))
    }

    // Handle both 'promptId' and 'id' parameter names for compatibility
    const promptId = (params?.promptId || params?.id || params?.name) as string | undefined

    if (!promptId) {
      throw {
        code: MCP_ERRORS.INVALID_PARAMS,
        message: 'Missing required parameter: promptId',
      }
    }

    try {
      // Render the prompt with Handlebars
      const content = this.promptRegistry.renderPrompt(promptId, params?.arguments || {})

      if (!content) {
        throw {
          code: MCP_ERRORS.PROMPT_NOT_FOUND,
          message: `Prompt not found: ${promptId}`,
        }
      }

      // Get the prompt info for description
      const promptInfo = this.promptRegistry.getPrompt(promptId)

      const result: GetPromptResult = {
        description: promptInfo?.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: content,
            },
          },
        ],
      }

      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      }
    } catch (error) {
      // Re-throw if it's already a JSON-RPC error
      if (error && typeof error === 'object' && 'code' in error) {
        throw error
      }

      console.error('Error getting prompt:', error)
      throw {
        code: MCP_ERRORS.INTERNAL_ERROR,
        message: 'Failed to get prompt',
      }
    }
  }
}
