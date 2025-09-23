// Search Files Tool - Similar to Cline's search_files
import { BaseTool, ToolExecutionContext, ToolExecutionResult } from '../registry';
import { sandboxManager } from '../../sandbox/manager';

export class SearchFilesTool extends BaseTool {
  name = 'search_files';
  description = 'Search for text patterns across files in a directory using grep. Useful for finding specific code patterns, function definitions, or text content.';
  
  parameters = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to search in (relative to working directory)'
      },
      pattern: {
        type: 'string',
        description: 'The text pattern to search for (supports basic regex)'
      },
      file_pattern: {
        type: 'string',
        description: 'Optional file pattern to filter files (e.g., "*.py", "*.js", "*.txt")'
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether the search should be case sensitive (default: false)'
      }
    },
    required: ['path', 'pattern']
  };

  async execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    try {
      this.validateParams(params);
      const { 
        path, 
        pattern, 
        file_pattern = '*', 
        case_sensitive = false 
      } = params;

      if (!path || typeof path !== 'string') {
        throw new Error('Path must be a non-empty string');
      }

      if (!pattern || typeof pattern !== 'string') {
        throw new Error('Pattern must be a non-empty string');
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

      // Build grep command
      const command = ['grep'];
      
      // Add flags
      command.push('-r'); // recursive
      command.push('-n'); // line numbers
      command.push('-H'); // show filenames
      
      if (!case_sensitive) {
        command.push('-i'); // case insensitive
      }

      // Add context lines for better understanding
      command.push('-C', '2'); // 2 lines of context before and after

      // Add the pattern
      command.push(pattern);

      // Add the search path
      command.push(path);

      // Add file pattern if specified and not default
      if (file_pattern && file_pattern !== '*') {
        command.push('--include=' + file_pattern);
      }

      const result = await sandboxManager.executeInSandbox(
        context.sandboxId,
        command,
        { 
          timeoutMs: Math.min(context.timeoutMs, 60000), // Max 60 seconds for search
          workingDir: context.workingDir 
        }
      );

      const latencyMs = Date.now() - startTime;

      // grep returns exit code 1 when no matches found, which is not an error
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return {
          success: false,
          result: '',
          error: `Search failed: ${result.stderr}`,
          latencyMs
        };
      }

      const output = result.stdout.trim();
      const matchCount = output ? output.split('\n').filter(line => 
        line.includes(':') && !line.startsWith('--')
      ).length : 0;

      let formattedResult = '';
      if (output) {
        formattedResult = `Found ${matchCount} matches:\n\n${output}`;
      } else {
        formattedResult = `No matches found for pattern "${pattern}" in ${path}`;
      }

      return {
        success: true,
        result: formattedResult,
        latencyMs,
        metadata: {
          path: path,
          pattern: pattern,
          file_pattern: file_pattern,
          case_sensitive: case_sensitive,
          matchCount: matchCount,
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
