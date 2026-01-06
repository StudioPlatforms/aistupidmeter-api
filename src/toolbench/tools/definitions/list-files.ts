// List Files Tool Definitions with Model-Specific Variants
// Based on Cline's list_files tool

import { ModelFamily, ToolSpec } from '../spec';

const list_files_generic: ToolSpec = {
  variant: ModelFamily.GENERIC,
  id: 'list_files',
  name: 'list_files',
  description:
    'Request to list files and directories within the specified directory. If recursive is true, it will list all files and directories recursively. If recursive is false or not provided, it will only list the top-level contents.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the directory to list contents for (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}',
      usage: 'src',
      type: 'string',
    },
    {
      name: 'recursive',
      required: false,
      instruction: 'Whether to list files recursively. Use true for recursive listing, false for top-level only.',
      usage: 'false',
      type: 'boolean',
    },
  ],
};

const list_files_openai: ToolSpec = {
  ...list_files_generic,
  variant: ModelFamily.OPENAI,
};

const list_files_gemini: ToolSpec = {
  ...list_files_generic,
  variant: ModelFamily.GEMINI,
};

export const list_files_variants: ToolSpec[] = [
  list_files_generic,
  list_files_openai,
  list_files_gemini,
];
