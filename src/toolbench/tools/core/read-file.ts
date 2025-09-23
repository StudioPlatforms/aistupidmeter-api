// Read File Tool - Similar to Cline's read_file
import { BaseTool, ToolExecutionContext, ToolExecutionResult } from '../registry';
import { sandboxManager } from '../../sandbox/manager';

export class ReadFileTool extends BaseTool {
  name = 'read_file';
  description = 'Read the contents of a file in the sandbox. Use this to examine existing files, analyze code, or extract information from text files.';
  
  parameters = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to read (relative to the working directory)'
      }
    },
    required: ['path']
  };

  async execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    try {
      this.validateParams(params);
      const { path } = params;

      if (!path || typeof path !== 'string') {
        throw new Error('Path must be a non-empty string');
      }

      // Security check - prevent reading sensitive files
      const dangerousPaths = [
        '/etc/passwd',
        '/etc/shadow',
        '/etc/hosts',
        '/proc/',
        '/sys/',
        '/dev/',
        '../'
      ];

      for (const dangerousPath of dangerousPaths) {
        if (path.includes(dangerousPath)) {
          throw new Error(`Access to path is restricted: ${path}`);
        }
      }

      // Read file from sandbox
      const content = await sandboxManager.readFile(context.sandboxId, path);
      const latencyMs = Date.now() - startTime;

      // Check if file is too large (limit to 1MB for display)
      if (content.length > 1024 * 1024) {
        return {
          success: false,
          result: '',
          error: `File is too large to read (${content.length} bytes). Maximum size is 1MB.`,
          latencyMs
        };
      }

      return {
        success: true,
        result: content,
        latencyMs,
        metadata: {
          path: path,
          size: content.length,
          lines: content.split('\n').length
        }
      };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        result: '',
        error: error instanceof Error ? error.message : String(error),
        latencyMs
      };
    }
  }
}
