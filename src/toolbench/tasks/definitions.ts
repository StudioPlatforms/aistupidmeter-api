// Tool Calling Benchmark Task Definitions
// Defines the specific tasks that models will be evaluated on

export interface TaskDefinition {
  slug: string;
  name: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  category: 'file_ops' | 'code_analysis' | 'system_interaction' | 'web_scraping' | 'data_processing' | 'multi_step';
  systemPrompt: string;
  initialMessage: string;
  successCriteria: {
    type: 'file_exists' | 'file_content' | 'command_output' | 'multi_criteria';
    criteria: any;
  };
  maxTurns: number;
  timeoutMs: number;
  sandboxConfig: {
    image?: string;
    networkAccess?: boolean;
    initialFiles?: Record<string, string>; // filename -> content
    environment?: Record<string, string>;
  };
  expectedTools: string[];
}

// Easy Tasks (Basic tool usage)
export const EASY_TASKS: TaskDefinition[] = [
  {
    slug: 'file_operations_easy',
    name: 'Basic File Operations',
    description: 'Create, read, and modify files using basic file operations',
    difficulty: 'easy',
    category: 'file_ops',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `Please create a file called "hello.txt" with the content "Hello, World!" and then read it back to confirm it was created correctly.`,
    successCriteria: {
      type: 'file_content',
      criteria: {
        path: 'hello.txt',
        expectedContent: 'Hello, World!'
      }
    },
    maxTurns: 5,
    timeoutMs: 60000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {},
      environment: {}
    },
    expectedTools: ['write_to_file', 'read_file']
  },

  {
    slug: 'directory_exploration_easy',
    name: 'Directory Exploration',
    description: 'Explore directory structure and find specific files',
    difficulty: 'easy',
    category: 'file_ops',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `I've placed some files in the current directory. Please list all files and then find any file that contains the word "secret" in its name.`,
    successCriteria: {
      type: 'multi_criteria',
      criteria: {
        usedListFiles: true,
        foundSecretFile: true
      }
    },
    maxTurns: 5,
    timeoutMs: 60000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {
        'readme.txt': 'This is a readme file.',
        'config.json': '{"setting": "value"}',
        'secret_key.txt': 'sk-1234567890abcdef',
        'data.csv': 'name,age\nJohn,25\nJane,30'
      },
      environment: {}
    },
    expectedTools: ['list_files', 'search_files']
  },

  {
    slug: 'simple_command_easy',
    name: 'Simple Command Execution',
    description: 'Execute basic system commands and interpret results',
    difficulty: 'easy',
    category: 'system_interaction',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `Please check what operating system we're running on and create a file called "system_info.txt" that contains the OS information.`,
    successCriteria: {
      type: 'file_exists',
      criteria: {
        path: 'system_info.txt'
      }
    },
    maxTurns: 5,
    timeoutMs: 60000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {},
      environment: {}
    },
    expectedTools: ['execute_command', 'write_to_file']
  }
];

// Medium Tasks (Multi-step operations)
export const MEDIUM_TASKS: TaskDefinition[] = [
  {
    slug: 'code_analysis_medium',
    name: 'Code Analysis and Modification',
    description: 'Analyze existing code and make specific modifications',
    difficulty: 'medium',
    category: 'code_analysis',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `I have a Python script that calculates the factorial of a number. Please find the script, analyze it, and add error handling for negative numbers. The script should print an error message for negative inputs.`,
    successCriteria: {
      type: 'file_content',
      criteria: {
        path: 'factorial.py',
        containsText: ['if', 'negative', 'error']
      }
    },
    maxTurns: 10,
    timeoutMs: 120000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {
        'factorial.py': `def factorial(n):
    if n == 0 or n == 1:
        return 1
    else:
        return n * factorial(n - 1)

number = int(input("Enter a number: "))
result = factorial(number)
print(f"The factorial of {number} is {result}")`,
        'test_data.txt': '5\n10\n-3\n0'
      },
      environment: {}
    },
    expectedTools: ['read_file', 'write_to_file', 'search_files']
  },

  {
    slug: 'data_processing_medium',
    name: 'Data Processing Pipeline',
    description: 'Process CSV data and generate summary statistics',
    difficulty: 'medium',
    category: 'data_processing',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `I have a CSV file with sales data. Please analyze it and create a summary report that includes: total sales, average sale amount, and the highest sale. Save the report as "sales_summary.txt".`,
    successCriteria: {
      type: 'file_exists',
      criteria: {
        path: 'sales_summary.txt'
      }
    },
    maxTurns: 10,
    timeoutMs: 120000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {
        'sales_data.csv': `date,product,amount
2024-01-01,Widget A,150.00
2024-01-02,Widget B,200.50
2024-01-03,Widget A,175.25
2024-01-04,Widget C,300.00
2024-01-05,Widget B,125.75
2024-01-06,Widget A,180.00`
      },
      environment: {}
    },
    expectedTools: ['read_file', 'write_to_file', 'execute_command']
  },

  {
    slug: 'project_setup_medium',
    name: 'Project Setup and Configuration',
    description: 'Set up a basic project structure with configuration files',
    difficulty: 'medium',
    category: 'multi_step',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `Please create a basic Node.js project structure with the following:
1. A package.json file with basic project info
2. A src/ directory with an index.js file
3. A README.md file explaining the project
4. Install dependencies if possible`,
    successCriteria: {
      type: 'multi_criteria',
      criteria: {
        hasPackageJson: true,
        hasSrcDirectory: true,
        hasIndexJs: true,
        hasReadme: true
      }
    },
    maxTurns: 15,
    timeoutMs: 180000,
    sandboxConfig: {
      networkAccess: true, // Needed for npm install
      initialFiles: {},
      environment: {}
    },
    expectedTools: ['write_to_file', 'execute_command', 'list_files']
  }
];

// Hard Tasks (Complex multi-step operations)
export const HARD_TASKS: TaskDefinition[] = [
  {
    slug: 'debugging_challenge_hard',
    name: 'Debug and Fix Complex Code',
    description: 'Debug a multi-file application with various issues',
    difficulty: 'hard',
    category: 'code_analysis',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `I have a Python application that's supposed to process user data and generate reports, but it has several bugs. Please:
1. Find and analyze all the files
2. Identify the bugs by running the code
3. Fix all issues
4. Verify the fixes work by running the application`,
    successCriteria: {
      type: 'command_output',
      criteria: {
        command: 'python main.py',
        expectedInOutput: ['Success', 'Report generated']
      }
    },
    maxTurns: 20,
    timeoutMs: 300000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {
        'main.py': `import json
from data_processor import process_users
from report_generator import generate_report

def main():
    # Load user data
    with open('users.json', 'r') as f:
        users = json.load(f)
    
    # Process users (has bug - missing import)
    processed = process_users(users)
    
    # Generate report (has bug - wrong function name)
    report = generate_reports(processed)
    
    # Save report
    with open('report.txt', 'w') as f:
        f.write(report)
    
    print("Success: Report generated")

if __name__ == "__main__":
    main()`,
        'data_processor.py': `def process_users(users):
    processed = []
    for user in users:
        # Bug: KeyError when 'age' is missing
        if user['age'] >= 18:
            processed.append({
                'name': user['name'],
                'age': user['age'],
                'category': 'adult'
            })
        else:
            processed.append({
                'name': user['name'],
                'age': user['age'],
                'category': 'minor'
            })
    return processed`,
        'report_generator.py': `def generate_report(users):
    total = len(users)
    adults = sum(1 for u in users if u['category'] == 'adult')
    minors = total - adults
    
    report = f"""User Report
Total Users: {total}
Adults: {adults}
Minors: {minors}
"""
    return report`,
        'users.json': `[
    {"name": "Alice", "age": 25},
    {"name": "Bob", "age": 17},
    {"name": "Charlie"},
    {"name": "Diana", "age": 30}
]`
      },
      environment: {}
    },
    expectedTools: ['read_file', 'write_to_file', 'execute_command', 'search_files']
  },

  {
    slug: 'system_automation_hard',
    name: 'System Automation Script',
    description: 'Create a comprehensive system automation script',
    difficulty: 'hard',
    category: 'system_interaction',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `Create a system monitoring and cleanup script that:
1. Checks disk usage and reports if any partition is >80% full
2. Lists the 10 largest files in the current directory
3. Creates a backup of important configuration files
4. Generates a system health report
5. The script should be executable and well-documented`,
    successCriteria: {
      type: 'multi_criteria',
      criteria: {
        scriptExists: true,
        scriptExecutable: true,
        reportGenerated: true,
        backupCreated: true
      }
    },
    maxTurns: 25,
    timeoutMs: 400000,
    sandboxConfig: {
      networkAccess: false,
      initialFiles: {
        'config1.conf': 'setting1=value1\nsetting2=value2',
        'config2.ini': '[section]\nkey=value',
        'large_file1.txt': 'x'.repeat(1000),
        'large_file2.txt': 'y'.repeat(2000),
        'small_file.txt': 'small content'
      },
      environment: {}
    },
    expectedTools: ['write_to_file', 'execute_command', 'list_files', 'read_file']
  },

  {
    slug: 'full_stack_challenge_hard',
    name: 'Full Stack Application Setup',
    description: 'Set up a complete web application with frontend, backend, and database',
    difficulty: 'hard',
    category: 'multi_step',
    systemPrompt: `You are an AI assistant that can use tools to interact with files and the system. You have access to tools like read_file, write_to_file, list_files, execute_command, and search_files. Use these tools to complete the requested tasks efficiently.`,
    initialMessage: `Create a simple full-stack web application with:
1. A Node.js/Express backend with a REST API
2. A simple HTML frontend that consumes the API
3. A JSON file as a simple database
4. The app should manage a list of tasks (CRUD operations)
5. Make sure everything works by starting the server and testing the endpoints`,
    successCriteria: {
      type: 'command_output',
      criteria: {
        command: 'curl -s http://localhost:3000/api/tasks',
        expectedInOutput: ['tasks', 'json']
      }
    },
    maxTurns: 30,
    timeoutMs: 500000,
    sandboxConfig: {
      networkAccess: true, // Needed for npm install and server testing
      initialFiles: {},
      environment: {
        'PORT': '3000'
      }
    },
    expectedTools: ['write_to_file', 'execute_command', 'read_file', 'list_files']
  }
];

// All tasks combined
export const ALL_TASKS: TaskDefinition[] = [
  ...EASY_TASKS,
  ...MEDIUM_TASKS,
  ...HARD_TASKS
];
