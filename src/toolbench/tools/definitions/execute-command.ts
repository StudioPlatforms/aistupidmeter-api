// Execute Command Tool Definitions with Model-Specific Variants
// Based on Cline's execute_command tool

import { ModelFamily, ToolSpec } from '../spec';

const execute_command_generic: ToolSpec = {
  variant: ModelFamily.GENERIC,
  id: 'execute_command',
  name: 'execute_command',
  description:
    'Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user\'s task. You must tailor your command to the user\'s system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user\'s shell. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands will be executed in the current working directory: {{CWD}}{{MULTI_ROOT_HINT}}',
  parameters: [
    {
      name: 'command',
      required: true,
      instruction: 'The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.',
      usage: 'npm install express',
      type: 'string',
    },
  ],
};

const execute_command_openai: ToolSpec = {
  variant: ModelFamily.OPENAI,
  id: 'execute_command',
  name: 'execute_command',
  description:
    'Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user\'s task. Do not use the ~ character or $HOME to refer to the home directory. Always use absolute paths when needed. The command will be executed from the current workspace directory.',
  parameters: [
    {
      name: 'command',
      required: true,
      instruction: 'The CLI command to execute. This should be valid for the current operating system. Do not use the ~ character or $HOME to refer to the home directory. Always use absolute paths. The command will be executed from the current workspace, you do not need to cd to the workspace.',
      type: 'string',
    },
  ],
};

const execute_command_gemini: ToolSpec = {
  variant: ModelFamily.GEMINI,
  id: 'execute_command',
  name: 'execute_command',
  description:
    'Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user\'s task. When chaining commands, use the shell operator && (not the HTML entity &amp;&amp;). If using search/grep commands, be careful to not use vague search terms that may return thousands of results.',
  parameters: [
    {
      name: 'command',
      required: true,
      instruction: 'The CLI command to execute. This should be valid for the current operating system. For command chaining, use proper shell operators like && to chain commands (e.g., \'cd path && command\'). Do not use the ~ character or $HOME to refer to the home directory. Always use absolute paths. Do not run search/grep commands that may return thousands of results.',
      type: 'string',
    },
  ],
};

export const execute_command_variants: ToolSpec[] = [
  execute_command_generic,
  execute_command_openai,
  execute_command_gemini,
];
