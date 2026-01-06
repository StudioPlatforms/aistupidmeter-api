// Read File Tool Definitions with Model-Specific Variants
// Based on Cline's read_file tool

import { ModelFamily, ToolSpec } from '../spec';

const read_file_generic: ToolSpec = {
  variant: ModelFamily.GENERIC,
  id: 'read_file',
  name: 'read_file',
  description:
    'Request to read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file you do not know the contents of, for example to analyze code, review text files, or extract information from configuration files. Automatically extracts raw text from PDF and DOCX files. May not be suitable for other types of binary files, as it returns the raw content as a string. Do NOT use this tool to list the contents of a directory. Only use this tool on files.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the file to read (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}',
      usage: 'src/index.js',
      type: 'string',
    },
  ],
};

const read_file_openai: ToolSpec = {
  variant: ModelFamily.OPENAI,
  id: 'read_file',
  name: 'read_file',
  description:
    'Request to read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file you do not know the contents of, for example to analyze code, review text files, or extract information from configuration files. Automatically extracts raw text from PDF and DOCX files. May not be suitable for other types of binary files, as it returns the raw content as a string. Do NOT use this tool to list the contents of a directory. Only use this tool on files.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the file to read (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}',
      usage: 'src/index.js',
      type: 'string',
    },
  ],
};

const read_file_gemini: ToolSpec = {
  ...read_file_openai,
  variant: ModelFamily.GEMINI,
};

export const read_file_variants: ToolSpec[] = [
  read_file_generic,
  read_file_openai,
  read_file_gemini,
];
