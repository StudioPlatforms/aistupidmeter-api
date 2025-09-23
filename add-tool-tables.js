#!/usr/bin/env node

const Database = require('better-sqlite3');
const path = require('path');

// Connect to the REAL database
const dbPath = path.join(__dirname, 'data/stupid_meter.db');
const db = new Database(dbPath);

console.log('🔧 Adding missing tool calling tables to production database...');

try {
  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  // Add missing columns to models table
  try {
    db.exec(`ALTER TABLE models ADD COLUMN supports_tool_calling INTEGER DEFAULT 0;`);
    console.log('✅ Added supports_tool_calling column to models table');
  } catch (error) {
    if (error.message.includes('duplicate column name')) {
      console.log('ℹ️ supports_tool_calling column already exists in models table');
    } else {
      throw error;
    }
  }

  try {
    db.exec(`ALTER TABLE models ADD COLUMN max_tools_per_call INTEGER DEFAULT 10;`);
    console.log('✅ Added max_tools_per_call column to models table');
  } catch (error) {
    if (error.message.includes('duplicate column name')) {
      console.log('ℹ️ max_tools_per_call column already exists in models table');
    } else {
      throw error;
    }
  }

  try {
    db.exec(`ALTER TABLE models ADD COLUMN tool_call_reliability REAL DEFAULT 0.0;`);
    console.log('✅ Added tool_call_reliability column to models table');
  } catch (error) {
    if (error.message.includes('duplicate column name')) {
      console.log('ℹ️ tool_call_reliability column already exists in models table');
    } else {
      throw error;
    }
  }

  // Create tool_tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      category TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      initial_message TEXT NOT NULL,
      success_criteria TEXT NOT NULL,
      max_turns INTEGER DEFAULT 10,
      timeout_ms INTEGER DEFAULT 300000,
      sandbox_config TEXT NOT NULL,
      expected_tools TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      active INTEGER DEFAULT 1
    );
  `);
  console.log('✅ Created tool_tasks table');

  // Create tool_sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      task_id INTEGER NOT NULL REFERENCES tool_tasks(id),
      task_slug TEXT NOT NULL,
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      total_latency_ms INTEGER NOT NULL DEFAULT 0,
      total_tokens_in INTEGER NOT NULL DEFAULT 0,
      total_tokens_out INTEGER NOT NULL DEFAULT 0,
      tool_calls_count INTEGER NOT NULL DEFAULT 0,
      successful_tool_calls INTEGER NOT NULL DEFAULT 0,
      failed_tool_calls INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      final_score REAL NOT NULL DEFAULT 0.0,
      conversation_data TEXT,
      tool_call_history TEXT,
      error_log TEXT,
      sandbox_id TEXT,
      completed_at TEXT
    );
  `);
  console.log('✅ Created tool_sessions table');

  // Create tool_metrics table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_metrics (
      session_id INTEGER PRIMARY KEY REFERENCES tool_sessions(id),
      tool_selection REAL NOT NULL,
      parameter_accuracy REAL NOT NULL,
      error_handling REAL NOT NULL,
      task_completion REAL NOT NULL,
      efficiency REAL NOT NULL,
      context_awareness REAL NOT NULL,
      safety_compliance REAL NOT NULL,
      avg_tool_latency REAL NOT NULL DEFAULT 0.0,
      tool_diversity REAL NOT NULL DEFAULT 0.0,
      conversation_flow REAL NOT NULL DEFAULT 0.0
    );
  `);
  console.log('✅ Created tool_metrics table');

  // Create tool_executions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES tool_sessions(id),
      turn_number INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      parameters TEXT NOT NULL,
      result TEXT NOT NULL,
      success INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error_message TEXT,
      ts TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Created tool_executions table');

  // Insert initial tool tasks
  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tool_tasks (slug, name, description, difficulty, category, system_prompt, initial_message, success_criteria, max_turns, timeout_ms, sandbox_config, expected_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tasks = [
    {
      slug: 'file_operations_easy',
      name: 'Basic File Operations',
      description: 'Create, read, and modify text files with specific content requirements',
      difficulty: 'easy',
      category: 'file_management',
      system_prompt: 'You are a helpful assistant that can perform file operations. Use the available tools to complete the requested tasks accurately.',
      initial_message: 'Please create a file called "test.txt" with the content "Hello World" and then read it back to confirm it was created correctly.',
      success_criteria: JSON.stringify({
        files_created: 1,
        content_accuracy: 1.0,
        file_read_successfully: true
      }),
      max_turns: 5,
      timeout_ms: 300000,
      sandbox_config: JSON.stringify({
        timeout: 300,
        max_file_size: '1MB',
        allowed_extensions: ['.txt', '.md', '.json']
      }),
      expected_tools: JSON.stringify(['write_to_file', 'read_file'])
    },
    {
      slug: 'directory_exploration_easy',
      name: 'Directory Structure Analysis',
      description: 'Navigate and analyze directory structures, finding specific files',
      difficulty: 'easy',
      category: 'file_management',
      system_prompt: 'You are a helpful assistant that can explore directory structures. Use the available tools to analyze and navigate file systems.',
      initial_message: 'Please explore the current directory structure and find all .js files. List their names and sizes.',
      success_criteria: JSON.stringify({
        directories_explored: 1,
        files_found: 'any',
        analysis_provided: true
      }),
      max_turns: 5,
      timeout_ms: 300000,
      sandbox_config: JSON.stringify({
        timeout: 300,
        max_directories: 10,
        read_only: true
      }),
      expected_tools: JSON.stringify(['list_files', 'read_file'])
    },
    {
      slug: 'code_search_medium',
      name: 'Code Search and Analysis',
      description: 'Search for specific code patterns and analyze their usage',
      difficulty: 'medium',
      category: 'development',
      system_prompt: 'You are a helpful assistant that can search and analyze code. Use the available tools to find patterns and provide insights.',
      initial_message: 'Please search for all function definitions in the current directory and provide a summary of what you find.',
      success_criteria: JSON.stringify({
        patterns_found: 'any',
        analysis_provided: true,
        search_performed: true
      }),
      max_turns: 8,
      timeout_ms: 600000,
      sandbox_config: JSON.stringify({
        timeout: 600,
        max_file_size: '5MB',
        allowed_extensions: ['.js', '.ts', '.py', '.java']
      }),
      expected_tools: JSON.stringify(['search_files', 'read_file', 'list_files'])
    }
  ];

  for (const task of tasks) {
    insertTask.run(
      task.slug,
      task.name,
      task.description,
      task.difficulty,
      task.category,
      task.system_prompt,
      task.initial_message,
      task.success_criteria,
      task.max_turns,
      task.timeout_ms,
      task.sandbox_config,
      task.expected_tools
    );
  }

  console.log('✅ Successfully added all tool calling tables and initial tasks');
  console.log('✅ Database migration completed successfully');

} catch (error) {
  console.error('❌ Error adding tables:', error);
  process.exit(1);
} finally {
  db.close();
}
