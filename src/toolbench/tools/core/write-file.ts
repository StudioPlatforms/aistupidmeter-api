// Write File Tool - Similar to Cline's write_to_file
import { BaseTool, ToolExecutionContext, ToolExecutionResult } from '../registry';
import { sandboxManager } from '../../sandbox/manager';

export class WriteFileTool extends BaseTool {
  name = 'write_to_file';
  description = 'Write content to a file in the sandbox. If the file exists, it will be overwritten. If it doesn\'t exist, it will be created along with any necessary directories.';
  
  parameters = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to write to (relative to the working directory)'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['path', 'content']
  };

  async execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    try {
      this.validateParams(params);
      const { path, content } = params;

      if (!path || typeof path !== 'string') {
        throw new Error('Path must be a non-empty string');
      }

      if (typeof content !== 'string') {
        throw new Error('Content must be a string');
      }

      // Security check - prevent writing to sensitive locations
      const dangerousPaths = [
        '/etc/',
        '/proc/',
        '/sys/',
        '/dev/',
        '/bin/',
        '/sbin/',
        '/usr/bin/',
        '/usr/sbin/',
        '../'
      ];

      for (const dangerousPath of dangerousPaths) {
        if (path.includes(dangerousPath)) {
          throw new Error(`Writing to path is restricted: ${path}`);
        }
      }

      // Check content size (limit to 10MB)
      if (content.length > 10 * 1024 * 1024) {
        throw new Error(`Content is too large (${content.length} bytes). Maximum size is 10MB.`);
      }

      // Create directory structure if needed
      const dirPath = path.substring(0, path.lastIndexOf('/'));
      if (dirPath) {
        await sandboxManager.executeInSandbox(
          context.sandboxId,
          ['mkdir', '-p', dirPath],
          { timeoutMs: 10000 }
        );
      }

      // Write file to sandbox
      await sandboxManager.writeFile(context.sandboxId, path, content);
      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        result: `Successfully wrote ${content.length} bytes to ${path}`,
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
