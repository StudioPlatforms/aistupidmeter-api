// Search Files Tool Definitions with Model-Specific Variants
// Based on Cline's search_files tool

import { ModelFamily, ToolSpec } from '../spec';

const search_files_generic: ToolSpec = {
  variant: ModelFamily.GENERIC,
  id: 'search_files',
  name: 'search_files',
  description:
    'Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context. Craft your regex patterns carefully to balance specificity and flexibility.',
  parameters: [
    {
      name: 'path',
      required: true,
      instruction: 'The path of the directory to search in (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}. This directory will be recursively searched.',
      usage: 'src',
      type: 'string',
    },
    {
      name: 'regex',
      required: true,
      instruction: 'The regular expression pattern to search for. Uses standard regex syntax.',
      usage: 'function\\s+\\w+',
      type: 'string',
    },
    {
      name: 'file_pattern',
      required: false,
      instruction: 'Optional glob pattern to filter files (e.g., \'*.ts\' for TypeScript files). If not provided, it will search all files (*).',
      usage: '*.js',
      type: 'string',
    },
  ],
};

const search_files_openai: ToolSpec = {
  ...search_files_generic,
  variant: ModelFamily.OPENAI,
};

const search_files_gemini: ToolSpec = {
  ...search_files_generic,
  variant: ModelFamily.GEMINI,
};

export const search_files_variants: ToolSpec[] = [
  search_files_generic,
  search_files_openai,
  search_files_gemini,
];
