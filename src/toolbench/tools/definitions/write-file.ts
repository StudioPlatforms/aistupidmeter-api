// Write File Tool Definitions with Model-Specific Variants
// Based on Cline's write_to_file tool

import { ModelFamily, ToolSpec } from '../spec';

const write_to_file_generic: ToolSpec = {
  variant: ModelFamily.GENERIC,
  id: 'write_to_file',
  name: 'write_to_file',
  description:
    'Request to write content to a file at the specified path. If the file exists, it will be overwritten with the provided content. If the file doesn\'t exist, it will be created. This tool will automatically create any directories needed to write the file.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the file to write to (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}',
      usage: 'src/app.js',
      type: 'string',
    },
    {
      name: 'content',
      required: true,
      instruction: 'The content to write to the file. ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. You MUST include ALL parts of the file, even if they haven\'t been modified.',
      usage: 'console.log("Hello, World!");',
      type: 'string',
    },
  ],
};

const write_to_file_openai: ToolSpec = {
  variant: ModelFamily.OPENAI,
  id: 'write_to_file',
  name: 'write_to_file',
  description:
    '[IMPORTANT: Always output the path first] Request to write content to a file at the specified path. If the file exists, it will be overwritten with the provided content. If the file doesn\'t exist, it will be created. This tool will automatically create any directories needed to write the file.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the file to write to (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}',
      type: 'string',
    },
    {
      name: 'content',
      required: true,
      instruction: 'After providing the path so a file can be created, then use this to provide the content to write to the file. ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions.',
      type: 'string',
    },
  ],
};

const write_to_file_gemini: ToolSpec = {
  ...write_to_file_generic,
  variant: ModelFamily.GEMINI,
};

export const write_to_file_variants: ToolSpec[] = [
  write_to_file_generic,
  write_to_file_openai,
  write_to_file_gemini,
];
