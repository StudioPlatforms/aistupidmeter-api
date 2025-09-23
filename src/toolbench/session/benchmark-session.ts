// Tool Benchmark Session
// Orchestrates the complete benchmark process for a single model-task combination

import { db } from '../../db';
import { tool_sessions, tool_metrics, tool_executions, tool_tasks } from '../../db/schema';
import { TaskDefinition } from '../tasks/definitions';
import { executionEngine, SessionContext } from '../engine/execution';
import { sandboxManager } from '../sandbox/manager';
import { LLMAdapter, ChatRequest } from '../../llm/adapters';
import { registerCoreTools } from '../tools/core';
import { eq } from 'drizzle-orm';

export interface BenchmarkResult {
  sessionId: number;
  passed: boolean;
  finalScore: number;
  metrics: {
    toolSelection: number;
    parameterAccuracy: number;
    errorHandling: number;
    taskCompletion: number;
    efficiency: number;
    contextAwareness: number;
    safetyCompliance: number;
    avgToolLatency: number;
    toolDiversity: number;
    conversationFlow: number;
  };
  summary: {
    totalTurns: number;
    totalLatencyMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    toolCallsCount: number;
    successfulToolCalls: number;
    failedToolCalls: number;
    uniqueToolsUsed: string[];
    errors: string[];
  };
}

export class ToolBenchmarkSession {
  private sessionId?: number;
  private sandboxId?: string;
  private context?: SessionContext;

  constructor(
    private model: { id: number; name: string; vendor: string },
    private task: TaskDefinition,
    private adapter: LLMAdapter
  ) {
    // Ensure core tools are registered
    registerCoreTools();
  }

  async run(): Promise<BenchmarkResult> {
    try {
      // Initialize session
      await this.initializeSession();
      
      // Run the benchmark
      const result = await this.executeBenchmark();
      
      // Save results to database
      await this.saveResults(result);
      
      return result;

    } catch (error) {
      console.error('Benchmark session failed:', error);
      
      // Clean up on error
      if (this.sandboxId) {
        await sandboxManager.destroySandbox(this.sandboxId).catch(() => {});
      }
      
      throw error;
    } finally {
      // Always clean up sandbox
      if (this.sandboxId) {
        await sandboxManager.destroySandbox(this.sandboxId).catch(() => {});
      }
    }
  }

  private async initializeSession(): Promise<void> {
    // Create sandbox
    this.sandboxId = await sandboxManager.createSandbox({
      networkAccess: this.task.sandboxConfig.networkAccess || false,
      environment: this.task.sandboxConfig.environment || {},
      timeoutMs: this.task.timeoutMs
    });

    // Set up initial files
    if (this.task.sandboxConfig.initialFiles) {
      await executionEngine.setupSandboxFiles(
        this.sandboxId,
        this.task.sandboxConfig.initialFiles
      );
    }

    // Create database session record
    const [session] = await db.insert(tool_sessions).values({
      modelId: this.model.id,
      taskId: await this.getTaskId(),
      taskSlug: this.task.slug,
      status: 'running',
      sandboxId: this.sandboxId
    }).returning();

    this.sessionId = session.id;

    // Initialize session context
    this.context = {
      sessionId: this.sessionId.toString(),
      sandboxId: this.sandboxId,
      workingDir: '/workspace',
      timeoutMs: this.task.timeoutMs,
      maxTurns: this.task.maxTurns,
      currentTurn: 0,
      messages: [
        { role: 'system', content: this.task.systemPrompt },
        { role: 'user', content: this.task.initialMessage }
      ],
      toolExecutions: [],
      errors: []
    };
  }

  private async executeBenchmark(): Promise<BenchmarkResult> {
    if (!this.context || !this.sessionId) {
      throw new Error('Session not initialized');
    }

    const startTime = Date.now();
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    // Main conversation loop
    while (this.context.currentTurn < this.context.maxTurns) {
      this.context.currentTurn++;

      // Prepare LLM request
      const request: ChatRequest = {
        model: this.model.name, // Use the actual model name
        messages: this.context.messages,
        temperature: 0.2,
        maxTokens: 2000,
        tools: executionEngine.formatToolsForLLM(),
        toolChoice: 'auto'
      };

      // Execute conversation turn
      const { response, toolResults } = await executionEngine.runConversationTurn(
        this.adapter,
        request,
        this.context
      );

      // Track token usage
      totalTokensIn += response.tokensIn || 0;
      totalTokensOut += response.tokensOut || 0;

      // Check if task is complete
      const isComplete = await this.checkTaskCompletion();
      if (isComplete) {
        break;
      }

      // If no tool calls were made, end the session
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }
    }

    const totalLatencyMs = Date.now() - startTime;

    // Calculate metrics
    const toolMetrics = executionEngine.calculateToolMetrics(this.context);
    const taskSuccess = await this.checkTaskCompletion();
    const metrics = await this.calculateDetailedMetrics(taskSuccess);

    // Update session in database
    await db.update(tool_sessions)
      .set({
        status: 'completed',
        turns: this.context.currentTurn,
        totalLatencyMs,
        totalTokensIn,
        totalTokensOut,
        toolCallsCount: toolMetrics.toolCallsCount,
        successfulToolCalls: toolMetrics.successfulToolCalls,
        failedToolCalls: toolMetrics.failedToolCalls,
        passed: taskSuccess,
        finalScore: metrics.taskCompletion,
        conversationData: this.context.messages,
        toolCallHistory: this.context.toolExecutions,
        errorLog: this.context.errors,
        completedAt: new Date().toISOString()
      })
      .where(eq(tool_sessions.id, this.sessionId));

    return {
      sessionId: this.sessionId,
      passed: taskSuccess,
      finalScore: metrics.taskCompletion,
      metrics,
      summary: {
        totalTurns: this.context.currentTurn,
        totalLatencyMs,
        totalTokensIn,
        totalTokensOut,
        toolCallsCount: toolMetrics.toolCallsCount,
        successfulToolCalls: toolMetrics.successfulToolCalls,
        failedToolCalls: toolMetrics.failedToolCalls,
        uniqueToolsUsed: toolMetrics.uniqueToolsUsed,
        errors: this.context.errors
      }
    };
  }

  private async checkTaskCompletion(): Promise<boolean> {
    if (!this.sandboxId) return false;

    try {
      const criteria = this.task.successCriteria;

      switch (criteria.type) {
        case 'file_exists':
          try {
            await sandboxManager.readFile(this.sandboxId, criteria.criteria.path);
            return true;
          } catch {
            return false;
          }

        case 'file_content':
          try {
            const content = await sandboxManager.readFile(this.sandboxId, criteria.criteria.path);
            if (criteria.criteria.expectedContent) {
              return content.includes(criteria.criteria.expectedContent);
            }
            if (criteria.criteria.containsText) {
              return criteria.criteria.containsText.every((text: string) => 
                content.toLowerCase().includes(text.toLowerCase())
              );
            }
            return true;
          } catch {
            return false;
          }

        case 'command_output':
          try {
            const result = await sandboxManager.executeInSandbox(
              this.sandboxId,
              [criteria.criteria.command],
              { timeoutMs: 30000 }
            );
            if (criteria.criteria.expectedInOutput) {
              return criteria.criteria.expectedInOutput.every((text: string) =>
                result.stdout.toLowerCase().includes(text.toLowerCase())
              );
            }
            return result.exitCode === 0;
          } catch {
            return false;
          }

        case 'multi_criteria':
          // Custom logic for multi-criteria tasks
          return await this.checkMultiCriteria(criteria.criteria);

        default:
          return false;
      }
    } catch (error) {
      console.error('Error checking task completion:', error);
      return false;
    }
  }

  private async checkMultiCriteria(criteria: any): Promise<boolean> {
    if (!this.sandboxId || !this.context) return false;

    try {
      // Check if list_files was used
      if (criteria.usedListFiles) {
        const usedListFiles = this.context.toolExecutions.some(e => e.toolName === 'list_files');
        if (!usedListFiles) return false;
      }

      // Check if secret file was found
      if (criteria.foundSecretFile) {
        const foundSecret = this.context.toolExecutions.some(e => 
          e.result.toLowerCase().includes('secret')
        );
        if (!foundSecret) return false;
      }

      // Check for specific files
      if (criteria.hasPackageJson) {
        try {
          await sandboxManager.readFile(this.sandboxId, 'package.json');
        } catch {
          return false;
        }
      }

      if (criteria.hasSrcDirectory) {
        try {
          const files = await sandboxManager.listFiles(this.sandboxId, 'src');
          if (files.length === 0) return false;
        } catch {
          return false;
        }
      }

      if (criteria.hasIndexJs) {
        try {
          await sandboxManager.readFile(this.sandboxId, 'src/index.js');
        } catch {
          return false;
        }
      }

      if (criteria.hasReadme) {
        try {
          await sandboxManager.readFile(this.sandboxId, 'README.md');
        } catch {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private async calculateDetailedMetrics(taskSuccess: boolean): Promise<BenchmarkResult['metrics']> {
    if (!this.context) {
      throw new Error('Context not available for metrics calculation');
    }

    const toolMetrics = executionEngine.calculateToolMetrics(this.context);
    const executions = this.context.toolExecutions;
    const errors = this.context.errors;

    // Tool Selection (0.0-1.0): How well the model chose appropriate tools
    const expectedTools = this.task.expectedTools;
    const usedTools = toolMetrics.uniqueToolsUsed;
    const expectedUsed = expectedTools.filter(tool => usedTools.includes(tool)).length;
    const toolSelection = expectedTools.length > 0 ? expectedUsed / expectedTools.length : 1.0;

    // Parameter Accuracy (0.0-1.0): Correctness of tool parameters
    const successfulCalls = executions.filter(e => e.success).length;
    const parameterAccuracy = executions.length > 0 ? successfulCalls / executions.length : 1.0;

    // Error Handling (0.0-1.0): Recovery from tool failures
    const failedCalls = executions.filter(e => !e.success);
    const recoveredFromErrors = failedCalls.filter(failed => {
      // Check if there was a successful retry of the same tool after failure
      const laterCalls = executions.filter(e => 
        e.turnNumber > failed.turnNumber && e.toolName === failed.toolName && e.success
      );
      return laterCalls.length > 0;
    }).length;
    const errorHandling = failedCalls.length > 0 ? recoveredFromErrors / failedCalls.length : 1.0;

    // Task Completion (0.0-1.0): Overall task success
    const taskCompletion = taskSuccess ? 1.0 : 0.0;

    // Efficiency (0.0-1.0): Minimal tool calls to achieve goal
    const maxExpectedCalls = this.task.maxTurns * 2; // Reasonable estimate
    const actualCalls = executions.length;
    const efficiency = Math.max(0, 1.0 - (actualCalls / maxExpectedCalls));

    // Context Awareness (0.0-1.0): Using previous tool results effectively
    let contextAwareActions = 0;
    for (let i = 1; i < executions.length; i++) {
      const current = executions[i];
      const previous = executions[i - 1];
      
      // Check if current action builds on previous result
      if (previous.success && current.parameters) {
        const prevResult = previous.result.toLowerCase();
        const currentParams = JSON.stringify(current.parameters).toLowerCase();
        if (prevResult.length > 10 && currentParams.includes(prevResult.substring(0, 20))) {
          contextAwareActions++;
        }
      }
    }
    const contextAwareness = executions.length > 1 ? contextAwareActions / (executions.length - 1) : 1.0;

    // Safety Compliance (0.0-1.0): Avoiding dangerous operations
    const dangerousActions = executions.filter(e => 
      e.errorMessage?.includes('restricted') || 
      e.errorMessage?.includes('dangerous') ||
      e.errorMessage?.includes('security')
    ).length;
    const safetyCompliance = Math.max(0, 1.0 - (dangerousActions / Math.max(executions.length, 1)));

    // Conversation Flow (0.0-1.0): Natural interaction patterns
    const conversationFlow = Math.min(1.0, this.context.messages.length / (this.context.currentTurn * 2));

    return {
      toolSelection: Math.round(toolSelection * 1000) / 1000,
      parameterAccuracy: Math.round(parameterAccuracy * 1000) / 1000,
      errorHandling: Math.round(errorHandling * 1000) / 1000,
      taskCompletion: Math.round(taskCompletion * 1000) / 1000,
      efficiency: Math.round(efficiency * 1000) / 1000,
      contextAwareness: Math.round(contextAwareness * 1000) / 1000,
      safetyCompliance: Math.round(safetyCompliance * 1000) / 1000,
      avgToolLatency: Math.round(toolMetrics.avgToolLatency * 100) / 100,
      toolDiversity: Math.round(toolMetrics.toolDiversity * 1000) / 1000,
      conversationFlow: Math.round(conversationFlow * 1000) / 1000
    };
  }

  private async saveResults(result: BenchmarkResult): Promise<void> {
    if (!this.sessionId) return;

    // Save detailed metrics
    await db.insert(tool_metrics).values({
      sessionId: this.sessionId,
      toolSelection: result.metrics.toolSelection,
      parameterAccuracy: result.metrics.parameterAccuracy,
      errorHandling: result.metrics.errorHandling,
      taskCompletion: result.metrics.taskCompletion,
      efficiency: result.metrics.efficiency,
      contextAwareness: result.metrics.contextAwareness,
      safetyCompliance: result.metrics.safetyCompliance,
      avgToolLatency: result.metrics.avgToolLatency,
      toolDiversity: result.metrics.toolDiversity,
      conversationFlow: result.metrics.conversationFlow
    });

    // Save individual tool executions
    if (this.context) {
      for (const execution of this.context.toolExecutions) {
        await db.insert(tool_executions).values({
          sessionId: this.sessionId,
          turnNumber: execution.turnNumber,
          toolName: execution.toolName,
          parameters: execution.parameters,
          result: execution.result,
          success: execution.success,
          latencyMs: execution.latencyMs,
          errorMessage: execution.errorMessage
        });
      }
    }
  }

  private async getTaskId(): Promise<number> {
    // Check if task exists in database, create if not
    const existingTask = await db.select()
      .from(tool_tasks)
      .where(eq(tool_tasks.slug, this.task.slug))
      .limit(1);

    if (existingTask.length > 0) {
      return existingTask[0].id;
    }

    // Create new task
    const [newTask] = await db.insert(tool_tasks).values({
      slug: this.task.slug,
      name: this.task.name,
      description: this.task.description,
      difficulty: this.task.difficulty,
      category: this.task.category,
      systemPrompt: this.task.systemPrompt,
      initialMessage: this.task.initialMessage,
      successCriteria: this.task.successCriteria,
      maxTurns: this.task.maxTurns,
      timeoutMs: this.task.timeoutMs,
      sandboxConfig: this.task.sandboxConfig,
      expectedTools: this.task.expectedTools
    }).returning();

    return newTask.id;
  }
}
