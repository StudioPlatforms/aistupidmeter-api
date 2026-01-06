// Tool Execution Engine
// Handles the execution of tool calls during benchmark sessions

import { toolRegistry } from '../tools/registry';
import { sandboxManager } from '../sandbox/manager';
import { ToolExecutionContext, ToolExecutionResult } from '../tools/registry';
import { ChatMessage, ChatRequest, ChatResponse, LLMAdapter } from '../../llm/adapters';

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolExecutionLog {
  turnNumber: number;
  toolName: string;
  parameters: Record<string, any>;
  result: string;
  success: boolean;
  latencyMs: number;
  errorMessage?: string;
  timestamp: Date;
}

export interface SessionContext {
  sessionId: string;
  sandboxId: string;
  workingDir: string;
  timeoutMs: number;
  maxTurns: number;
  currentTurn: number;
  messages: ChatMessage[];
  toolExecutions: ToolExecutionLog[];
  errors: string[];
}

export class ToolExecutionEngine {
  async executeToolCall(
    toolCall: ToolCall,
    context: SessionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Get the tool from registry
      const tool = toolRegistry.get(toolCall.name);
      if (!tool) {
        throw new Error(`Tool '${toolCall.name}' not found in registry`);
      }

      // Create execution context
      const execContext: ToolExecutionContext = {
        sandboxId: context.sandboxId,
        workingDir: context.workingDir,
        timeoutMs: context.timeoutMs
      };

      // Execute the tool
      const result = await tool.execute(toolCall.arguments, execContext);
      
      // Log the execution
      const executionLog: ToolExecutionLog = {
        turnNumber: context.currentTurn,
        toolName: toolCall.name,
        parameters: toolCall.arguments,
        result: result.result,
        success: result.success,
        latencyMs: result.latencyMs,
        errorMessage: result.error,
        timestamp: new Date()
      };

      context.toolExecutions.push(executionLog);

      if (!result.success && result.error) {
        context.errors.push(`Tool ${toolCall.name} failed: ${result.error}`);
      }

      return result;

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Log the failed execution
      const executionLog: ToolExecutionLog = {
        turnNumber: context.currentTurn,
        toolName: toolCall.name,
        parameters: toolCall.arguments,
        result: '',
        success: false,
        latencyMs,
        errorMessage,
        timestamp: new Date()
      };

      context.toolExecutions.push(executionLog);
      context.errors.push(`Tool execution failed: ${errorMessage}`);

      return {
        success: false,
        result: '',
        error: errorMessage,
        latencyMs
      };
    }
  }

  async processLLMResponse(
    response: ChatResponse,
    context: SessionContext
  ): Promise<{ toolResults: ToolExecutionResult[]; shouldContinue: boolean }> {
    const toolResults: ToolExecutionResult[] = [];
    
    // If no tool calls, just add the response to messages
    if (!response.toolCalls || response.toolCalls.length === 0) {
      if (response.text.trim()) {
        context.messages.push({
          role: 'assistant',
          content: response.text
        });
      }
      return { toolResults: [], shouldContinue: false };
    }

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      const result = await this.executeToolCall(toolCall, context);
      toolResults.push(result);

      // Add tool call result as a user message for the next turn
      const resultMessage = result.success 
        ? `Tool ${toolCall.name} executed successfully:\n${result.result}`
        : `Tool ${toolCall.name} failed: ${result.error || 'Unknown error'}`;

      context.messages.push({
        role: 'user',
        content: resultMessage
      });
    }

    return { toolResults, shouldContinue: true };
  }

  async runConversationTurn(
    adapter: LLMAdapter,
    request: ChatRequest,
    context: SessionContext
  ): Promise<{ response: ChatResponse; toolResults: ToolExecutionResult[] }> {
    // Helper to detect credit/quota exhaustion so callers can synthesize scores
    const isCreditExhausted = (error: any) => {
      const status = error?.status || error?.response?.status;
      const msg = String(error?.message || error).toLowerCase();
      if (status === 402) return true;
      if (status === 429) return msg.includes('credit') || msg.includes('quota') || msg.includes('billing') || msg.includes('balance');
      if (status === 403) return msg.includes('credit') || msg.includes('quota') || msg.includes('insufficient') || msg.includes('balance') || msg.includes('billing');
      return msg.includes('insufficient credits') ||
             msg.includes('insufficient_quota') ||
             msg.includes('quota exceeded') ||
             msg.includes('quota_exceeded') ||
             (msg.includes('credit') && msg.includes('exhaust')) ||
             msg.includes('billing') ||
             msg.includes('payment required') ||
             msg.includes('account_deactivated') ||
             msg.includes('subscription');
    };

    try {
      // Make the LLM call
      const response = await adapter.chat(request);
      
      // Add assistant response to context if there's text content
      if (response.text.trim()) {
        context.messages.push({
          role: 'assistant',
          content: response.text
        });
      }

      // Process any tool calls
      const { toolResults } = await this.processLLMResponse(response, context);

      return { response, toolResults };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.errors.push(`LLM call failed: ${errorMessage}`);

      // Bubble credit exhaustion so upstream can generate synthetic scores
      if (isCreditExhausted(error)) {
        throw error;
      }
      
      // Return a mock response for error handling
      const errorResponse: ChatResponse = {
        text: `Error: ${errorMessage}`,
        tokensIn: 0,
        tokensOut: 0,
        toolCalls: [],
        raw: { error: errorMessage }
      };

      return { response: errorResponse, toolResults: [] };
    }
  }

  formatToolsForLLM(provider?: string, modelId?: string, context?: any): any[] {
    // If provider and modelId are provided, use enhanced formatting
    if (provider && modelId) {
      return toolRegistry.formatToolsForLLM(provider, modelId, context);
    }

    // Fallback to old format for backward compatibility
    return toolRegistry.getDefinitions().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  async setupSandboxFiles(
    sandboxId: string,
    initialFiles: Record<string, string>
  ): Promise<void> {
    for (const [filename, content] of Object.entries(initialFiles)) {
      await sandboxManager.writeFile(sandboxId, filename, content);
    }
  }

  calculateToolMetrics(context: SessionContext): {
    toolCallsCount: number;
    successfulToolCalls: number;
    failedToolCalls: number;
    avgToolLatency: number;
    toolDiversity: number;
    uniqueToolsUsed: string[];
  } {
    const executions = context.toolExecutions;
    const successfulCalls = executions.filter(e => e.success);
    const failedCalls = executions.filter(e => !e.success);
    const uniqueTools = [...new Set(executions.map(e => e.toolName))];
    
    const avgLatency = executions.length > 0 
      ? executions.reduce((sum, e) => sum + e.latencyMs, 0) / executions.length 
      : 0;

    const diversity = uniqueTools.length / Math.max(toolRegistry.getAll().length, 1);

    return {
      toolCallsCount: executions.length,
      successfulToolCalls: successfulCalls.length,
      failedToolCalls: failedCalls.length,
      avgToolLatency: avgLatency,
      toolDiversity: diversity,
      uniqueToolsUsed: uniqueTools
    };
  }
}

// Global execution engine instance
export const executionEngine = new ToolExecutionEngine();
