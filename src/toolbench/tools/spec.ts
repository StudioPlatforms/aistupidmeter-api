// Enhanced Tool Specification System
// Inspired by Cline's tool specification system with support for multiple model families

export enum ModelFamily {
  GENERIC = 'generic',
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GEMINI = 'gemini',
  DEEPSEEK = 'deepseek',
  OPENROUTER = 'openrouter',
}

export interface ToolParameter {
  name: string;
  required: boolean;
  instruction: string | ((context: ToolContext) => string);
  usage?: string;
  description?: string;
  contextRequirements?: (context: ToolContext) => boolean;
  type?: 'string' | 'boolean' | 'integer' | 'array' | 'object';
  items?: any;
  properties?: Record<string, any>;
  // Additional JSON Schema fields
  [key: string]: any;
}

export interface ToolSpec {
  variant: ModelFamily;
  id: string;
  name: string;
  description: string;
  instruction?: string;
  contextRequirements?: (context: ToolContext) => boolean;
  parameters?: ToolParameter[];
}

export interface ToolContext {
  cwd: string;
  isMultiRoot?: boolean;
  sandboxId: string;
  modelFamily: ModelFamily;
  modelId: string;
  provider: string;
  [key: string]: any;
}

// OpenAI-compatible tool format
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
      additionalProperties?: boolean;
    };
  };
}

// Anthropic tool format
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

// Gemini tool format
export interface GeminiTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

/**
 * Resolves instruction text, handling both string and function types
 */
export function resolveInstruction(
  instruction: string | ((context: ToolContext) => string),
  context: ToolContext
): string {
  return typeof instruction === 'function' ? instruction(context) : instruction;
}

/**
 * Replaces template placeholders in descriptions
 */
export function replacePlaceholders(text: string, context: ToolContext): string {
  return text
    .replace(/\{\{CWD\}\}/g, context.cwd)
    .replace(/\{\{MULTI_ROOT_HINT\}\}/g, context.isMultiRoot ? ' (supports multi-workspace)' : '');
}

/**
 * Converts a ToolSpec to OpenAI-compatible format
 */
export function formatToolForOpenAI(tool: ToolSpec, context: ToolContext): OpenAITool {
  // Check context requirements
  if (tool.contextRequirements && !tool.contextRequirements(context)) {
    throw new Error(`Tool ${tool.name} does not meet context requirements`);
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (tool.parameters) {
    for (const param of tool.parameters) {
      // Check parameter context requirements
      if (param.contextRequirements && !param.contextRequirements(context)) {
        continue;
      }

      if (param.required) {
        required.push(param.name);
      }

      const paramType = param.type || 'string';
      const paramSchema: any = {
        type: paramType,
        description: replacePlaceholders(resolveInstruction(param.instruction, context), context),
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

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: replacePlaceholders(tool.description, context),
      strict: false,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

/**
 * Converts a ToolSpec to Anthropic-compatible format
 */
export function formatToolForAnthropic(tool: ToolSpec, context: ToolContext): AnthropicTool {
  // Check context requirements
  if (tool.contextRequirements && !tool.contextRequirements(context)) {
    throw new Error(`Tool ${tool.name} does not meet context requirements`);
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (tool.parameters) {
    for (const param of tool.parameters) {
      // Check parameter context requirements
      if (param.contextRequirements && !param.contextRequirements(context)) {
        continue;
      }

      if (param.required) {
        required.push(param.name);
      }

      const paramType = param.type || 'string';
      const paramSchema: any = {
        type: paramType,
        description: replacePlaceholders(resolveInstruction(param.instruction, context), context),
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

  return {
    name: tool.name,
    description: replacePlaceholders(tool.description, context),
    input_schema: {
      type: 'object',
      properties,
      required,
    },
  };
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'NUMBER',
  boolean: 'BOOLEAN',
  object: 'OBJECT',
  array: 'STRING',
};

/**
 * Converts a ToolSpec to Gemini-compatible format
 */
export function formatToolForGemini(tool: ToolSpec, context: ToolContext): GeminiTool {
  // Check context requirements
  if (tool.contextRequirements && !tool.contextRequirements(context)) {
    throw new Error(`Tool ${tool.name} does not meet context requirements`);
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (tool.parameters) {
    for (const param of tool.parameters) {
      // Check parameter context requirements
      if (param.contextRequirements && !param.contextRequirements(context)) {
        continue;
      }

      if (!param.name) {
        continue;
      }

      if (param.required) {
        required.push(param.name);
      }

      const paramSchema: any = {
        type: GEMINI_TYPE_MAP[param.type || 'string'] || 'OBJECT',
        description: replacePlaceholders(resolveInstruction(param.instruction, context), context),
      };

      if (param.properties) {
        paramSchema.properties = {};
        for (const [key, prop] of Object.entries<any>(param.properties)) {
          if (key === '$schema') {
            continue;
          }
          paramSchema.properties[key] = {
            type: GEMINI_TYPE_MAP[prop.type || 'string'] || 'OBJECT',
            description: prop.description || '',
          };

          if (prop.enum) {
            paramSchema.properties[key].enum = prop.enum;
          }
        }
      }

      properties[param.name] = paramSchema;
    }
  }

  return {
    name: tool.name,
    description: replacePlaceholders(tool.description, context),
    parameters: {
      type: 'OBJECT',
      properties,
      required,
    },
  };
}

/**
 * Get the appropriate formatter for a given provider
 */
export function getFormatterForProvider(providerId: string, modelId?: string): (tool: ToolSpec, context: ToolContext) => any {
  const lowerProviderId = providerId.toLowerCase();
  const lowerModelId = modelId?.toLowerCase() || '';

  // Anthropic and Claude
  if (lowerProviderId.includes('anthropic') || lowerProviderId.includes('claude')) {
    return formatToolForAnthropic;
  }

  // Gemini
  if (lowerProviderId.includes('gemini') || lowerModelId.includes('gemini')) {
    return formatToolForGemini;
  }

  // Default to OpenAI format (works for most providers)
  return formatToolForOpenAI;
}

/**
 * Get model family from provider and model ID
 */
export function getModelFamily(providerId: string, modelId?: string): ModelFamily {
  const lowerProviderId = providerId.toLowerCase();
  const lowerModelId = modelId?.toLowerCase() || '';

  if (lowerProviderId.includes('anthropic') || lowerProviderId.includes('claude')) {
    return ModelFamily.ANTHROPIC;
  }

  if (lowerProviderId.includes('gemini') || lowerModelId.includes('gemini')) {
    return ModelFamily.GEMINI;
  }

  if (lowerProviderId.includes('deepseek') || lowerModelId.includes('deepseek')) {
    return ModelFamily.DEEPSEEK;
  }

  if (lowerProviderId.includes('openai') || lowerModelId.includes('gpt')) {
    return ModelFamily.OPENAI;
  }

  if (lowerProviderId.includes('openrouter')) {
    return ModelFamily.OPENROUTER;
  }

  return ModelFamily.GENERIC;
}
