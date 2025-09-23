// Core Tools Registration
// Registers all core tools with the global registry

import { toolRegistry } from '../registry';
import { ExecuteCommandTool } from './execute-command';
import { ReadFileTool } from './read-file';
import { WriteFileTool } from './write-file';
import { ListFilesTool } from './list-files';
import { SearchFilesTool } from './search-files';

// Register all core tools
export function registerCoreTools(): void {
  toolRegistry.register(new ExecuteCommandTool());
  toolRegistry.register(new ReadFileTool());
  toolRegistry.register(new WriteFileTool());
  toolRegistry.register(new ListFilesTool());
  toolRegistry.register(new SearchFilesTool());
}

// Export tool classes for direct use if needed
export {
  ExecuteCommandTool,
  ReadFileTool,
  WriteFileTool,
  ListFilesTool,
  SearchFilesTool
};
