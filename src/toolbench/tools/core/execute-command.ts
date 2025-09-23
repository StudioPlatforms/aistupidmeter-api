// Execute Command Tool - Similar to Cline's execute_command
import { BaseTool, ToolExecutionContext, ToolExecutionResult } from '../registry';
import { sandboxManager } from '../../sandbox/manager';

export class ExecuteCommandTool extends BaseTool {
  name = 'execute_command';
  description = 'Execute a CLI command in the sandbox environment. Use this to run system commands, install packages, compile code, or perform any command-line operations.';
  
  parameters = {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute (e.g., "ls -la", "python script.py", "npm install")'
      }
    },
    required: ['command']
  };

  async execute(
    params: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    try {
      this.validateParams(params);
      const { command } = params;

      if (!command || typeof command !== 'string') {
        throw new Error('Command must be a non-empty string');
      }

      // Security check - prevent dangerous commands
      const dangerousPatterns = [
        /rm\s+-rf\s+\//, // rm -rf /
        /dd\s+if=/, // dd commands
        /mkfs/, // filesystem formatting
        /fdisk/, // disk partitioning
        /shutdown/, // system shutdown
        /reboot/, // system reboot
        /halt/, // system halt
        /init\s+0/, // system shutdown
        /kill\s+-9\s+1/, // kill init process
        /fork\s*\(\)/, // fork bombs
        /:\(\)\{.*\}/, // bash fork bombs
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          throw new Error(`Command contains potentially dangerous operations: ${command}`);
        }
      }

      // Execute command in sandbox
      const result = await sandboxManager.executeInSandbox(
        context.sandboxId,
        [command],
        { 
          timeoutMs: context.timeoutMs,
          workingDir: context.workingDir 
        }
      );

      const latencyMs = Date.now() - startTime;

      // Format output
      let output = '';
      if (result.stdout) {
        output += `STDOUT:\n${result.stdout}\n`;
      }
      if (result.stderr) {
        output += `STDERR:\n${result.stderr}\n`;
      }
      output += `Exit Code: ${result.exitCode}`;

      return {
        success: result.exitCode === 0,
        result: output,
        error: result.exitCode !== 0 ? `Command failed with exit code ${result.exitCode}` : undefined,
        latencyMs,
        metadata: {
          exitCode: result.exitCode,
          command: command
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
