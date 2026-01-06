// Enhanced Tool Registry for Benchmarking System
// Supports model-specific variants and multiple providers

import {
  ToolSpec,
  ToolContext,
  ModelFamily,
  getFormatterForProvider,
  getModelFamily
} from './spec';
import { ALL_TOOL_VARIANTS } from './definitions';

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
  modelFamily?: ModelFamily;
  provider?: string;
  modelId?: string;
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

// Enhanced Tool Registry with variant support
export class ToolRegistry {
  private tools = new Map<string, BaseTool>();
  private variants = new Map<ModelFamily, Map<string, ToolSpec>>();

  constructor() {
    // Register all tool variants
    this.registerVariants(ALL_TOOL_VARIANTS);
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  private registerVariants(variants: ToolSpec[]): void {
    for (const variant of variants) {
      if (!this.variants.has(variant.variant)) {
        this.variants.set(variant.variant, new Map());
      }
      const variantMap = this.variants.get(variant.variant)!;
      variantMap.set(variant.id, variant);
    }
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

  /**
   * Get tool specification variant for a specific model family
   * Falls back to GENERIC if specific variant doesn't exist
   */
  getToolSpec(toolId: string, modelFamily: ModelFamily): ToolSpec | undefined {
    // Try to get specific variant
    const variantMap = this.variants.get(modelFamily);
    if (variantMap && variantMap.has(toolId)) {
      return variantMap.get(toolId);
    }

    // Fall back to generic variant
    const genericMap = this.variants.get(ModelFamily.GENERIC);
    if (genericMap && genericMap.has(toolId)) {
      return genericMap.get(toolId);
    }

    return undefined;
  }

  /**
   * Get all tool specifications for a specific model family
   */
  getToolSpecs(modelFamily: ModelFamily): ToolSpec[] {
    const specs: ToolSpec[] = [];
    const seenIds = new Set<string>();

    // Get specific variants first
    const variantMap = this.variants.get(modelFamily);
    if (variantMap) {
      for (const spec of variantMap.values()) {
        specs.push(spec);
        seenIds.add(spec.id);
      }
    }

    // Add generic variants for tools not yet included
    const genericMap = this.variants.get(ModelFamily.GENERIC);
    if (genericMap) {
      for (const spec of genericMap.values()) {
        if (!seenIds.has(spec.id)) {
          specs.push(spec);
        }
      }
    }

    return specs;
  }

  /**
   * Format tools for LLM - returns simple ToolDef format
   * The adapters will handle provider-specific wrapping
   */
  formatToolsForLLM(
    provider: string,
    modelId: string,
    context: Partial<ToolContext> = {}
  ): any[] {
    const modelFamily = getModelFamily(provider, modelId);
    const toolSpecs = this.getToolSpecs(modelFamily);

    // Debug logging
    if (process.env.DEBUG_TOOLS) {
      console.log(`[ToolRegistry] Formatting ${toolSpecs.length} tools for provider: ${provider}, model: ${modelId}, family: ${modelFamily}`);
      console.log(`[ToolRegistry] Tool names:`, toolSpecs.map(s => s.name).join(', '));
    }

    const toolContext: ToolContext = {
      cwd: context.cwd || '/workspace',
      sandboxId: context.sandboxId || '',
      modelFamily,
      modelId,
      provider,
      ...context
    };

    return toolSpecs.map(spec => {
      try {
        // Build properties and required arrays
        const properties: Record<string, any> = {};
        const required: string[] = [];

        if (spec.parameters) {
          for (const param of spec.parameters) {
            // Check parameter context requirements
            if (param.contextRequirements && !param.contextRequirements(toolContext)) {
              continue;
            }

            if (param.required) {
              required.push(param.name);
            }

            const paramType = param.type || 'string';
            const paramSchema: any = {
              type: paramType,
              description: this.replacePlaceholders(
                this.resolveInstruction(param.instruction, toolContext),
                toolContext
              ),
            };

            // Add items for array types
            if (paramType === 'array' && param.items) {
              paramSchema.items = param.items;
            }

            // Add properties for object types
            if (paramType === 'object' && param.properties) {
              paramSchema.properties = param.properties;
            }

            // Preserve additional JSON Schema fields
            const reservedKeys = new Set([
              'name', 'required', 'instruction', 'usage', 'description',
              'contextRequirements', 'type', 'items', 'properties'
            ]);
            for (const key in param) {
              if (!reservedKeys.has(key) && param[key] !== undefined) {
                paramSchema[key] = param[key];
              }
            }

            properties[param.name] = paramSchema;
          }
        }

        // Return simple ToolDef format that adapters expect
        return {
          name: spec.name,
          description: this.replacePlaceholders(spec.description, toolContext),
          parameters: {
            type: 'object',
            properties,
            required
          }
        };
      } catch (error) {
        console.warn(`Failed to format tool ${spec.name}:`, error);
        return null;
      }
    }).filter(tool => tool !== null);
  }

  private resolveInstruction(
    instruction: string | ((context: ToolContext) => string),
    context: ToolContext
  ): string {
    return typeof instruction === 'function' ? instruction(context) : instruction;
  }

  private replacePlaceholders(text: string, context: ToolContext): string {
    return text
      .replace(/\{\{CWD\}\}/g, context.cwd)
      .replace(/\{\{MULTI_ROOT_HINT\}\}/g, context.isMultiRoot ? ' (supports multi-workspace)' : '');
  }
}

// Global registry instance
export const toolRegistry = new ToolRegistry();
