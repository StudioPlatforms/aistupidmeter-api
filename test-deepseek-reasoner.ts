import dotenv from 'dotenv';
dotenv.config({ path: '/root/.env' });

import { DeepSeekAdapter } from './src/llm/adapters';

async function testDeepSeekReasonerTools() {
  console.log('🧪 Testing deepseek-reasoner tool calling fix\n');
  
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('❌ DEEPSEEK_API_KEY not found');
    process.exit(1);
  }
  
  const adapter = new DeepSeekAdapter(apiKey);
  
  // Test with a simple tool call request
  const request = {
    model: 'deepseek-reasoner',
    messages: [
      {
        role: 'user' as const,
        content: 'Please use the list_files tool to list files in the /tmp directory'
      }
    ],
    tools: [
      {
        name: 'list_files',
        description: 'List files in a directory',
        parameters: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string' as const,
              description: 'Directory path to list'
            }
          },
          required: ['path']
        }
      }
    ],
    maxTokens: 1000,
    temperature: 0.3
  };
  
  console.log('Sending request to deepseek-reasoner with tool definitions...\n');
  
  try {
    const response = await adapter.chat(request);
    
    console.log('Response received!');
    console.log('Text length:', response.text?.length || 0);
    console.log('Tool calls:', response.toolCalls?.length || 0);
    console.log('Tokens in:', response.tokensIn);
    console.log('Tokens out:', response.tokensOut);
    
    if (response.toolCalls && response.toolCalls.length > 0) {
      console.log('\n🎉 SUCCESS! deepseek-reasoner made tool calls:');
      response.toolCalls.forEach((tc: any, i: number) => {
        console.log(`  ${i + 1}. ${tc.name}(${JSON.stringify(tc.arguments)})`);
      });
      console.log('\n✅ The fix works! Tool calling is now enabled for deepseek-reasoner');
      process.exit(0);
    } else {
      console.log('\n⚠️  No tool calls made');
      console.log('Response text:', response.text?.substring(0, 200));
      console.log('\nThis might mean the model chose not to use tools, or there\'s another issue');
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

testDeepSeekReasonerTools();
