// Tool Definitions Index
// Exports all tool definition variants

export { execute_command_variants } from './execute-command';
export { read_file_variants } from './read-file';
export { write_to_file_variants } from './write-file';
export { list_files_variants } from './list-files';
export { search_files_variants } from './search-files';

import { execute_command_variants } from './execute-command';
import { read_file_variants } from './read-file';
import { write_to_file_variants } from './write-file';
import { list_files_variants } from './list-files';
import { search_files_variants } from './search-files';
import { ToolSpec } from '../spec';

// All tool variants combined
export const ALL_TOOL_VARIANTS: ToolSpec[] = [
  ...execute_command_variants,
  ...read_file_variants,
  ...write_to_file_variants,
  ...list_files_variants,
  ...search_files_variants,
];
