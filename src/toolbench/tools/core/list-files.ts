// List Files Tool - Similar to Cline's list_files
import { BaseTool, ToolExecutionContext, ToolExecutionResult } from '../registry';
import { sandboxManager } from '../../sandbox/manager';

export class ListFilesTool extends BaseTool {
  name = 'list_files';
  description = 'List files and directories within a specified directory in the sandbox. Useful for exploring the file structure and understanding the project layout.';
  
  parameters = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'The path of the directory to list contents for (relative to working directory, defaults to ".")'
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list files recursively (default: false)'
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
      const { path = '.', recursive = false } = params;

      if (typeof path !== 'string') {
        throw new Error('Path must be a string');
      }

      // Security check - prevent accessing sensitive directories
      const dangerousPaths = [
        '/etc/',
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

      let command: string[];
      if (recursive) {
        // Use find for recursive listing
        command = ['find', path, '-type', 'f', '-o', '-type', 'd'];
      } else {
        // Use ls for non-recursive listing
        command = ['ls', '-la', path];
      }

      const result = await sandboxManager.executeInSandbox(
        context.sandboxId,
        command,
        { 
          timeoutMs: Math.min(context.timeoutMs, 30000), // Max 30 seconds for file listing
          workingDir: context.workingDir 
        }
      );

      const latencyMs = Date.now() - startTime;

      if (result.exitCode !== 0) {
        return {
          success: false,
          result: '',
          error: `Failed to list files: ${result.stderr}`,
          latencyMs
        };
      }

      // Parse and format the output
      const lines = result.stdout.split('\n').filter(line => line.trim());
      let formattedOutput: string;

      if (recursive) {
        // For recursive listing, just show the paths
        formattedOutput = lines.join('\n');
      } else {
        // For ls output, format it nicely
        formattedOutput = lines.join('\n');
      }

      return {
        success: true,
        result: formattedOutput,
        latencyMs,
        metadata: {
          path: path,
          recursive: recursive,
          itemCount: lines.length,
          command: command.join(' ')
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
