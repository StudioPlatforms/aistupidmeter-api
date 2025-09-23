// Tool Registry for Benchmarking System
// Implements core tools similar to Cline's tool system

export interface ToolParameter {
  type: string;
  description: string;
  required?: boolean;
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolExecutionContext {
  sandboxId: string;
  workingDir: string;
  timeoutMs: number;
}

export interface ToolExecutionResult {
  success: boolean;
  result: string;
  error?: string;
  latencyMs: number;
  metadata?: Record<string, any>;
}

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract parameters: ToolDefinition['parameters'];

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  abstract execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;

  protected validateParams(params: Record<string, any>): void {
    const required = this.parameters.required || [];
    for (const param of required) {
      if (!(param in params)) {
        throw new Error(`Missing required parameter: ${param}`);
      }
    }
  }
}

// Tool Registry
export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  getAll(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => tool.getDefinition());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// Global registry instance
export const toolRegistry = new ToolRegistry();
