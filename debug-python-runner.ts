import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

async function debugPythonRunner() {
  console.log('🔍 Debugging Python runner...');
  
  // Simple test code
  const testCode = `
def is_palindrome(text):
    processed_text = ''.join(c for c in text.lower() if c.isalnum())
    return processed_text == processed_text[::-1]
`.trim();

  const tmpDir = os.tmpdir();
  const solPath = path.join(tmpDir, `debug_sol_${Date.now()}.py`);
  const runnerPath = path.join(tmpDir, `debug_runner_${Date.now()}.py`);

  try {
    // Write the solution code
    await fs.writeFile(solPath, testCode);
    console.log('✅ Solution code written to:', solPath);
    console.log('📝 Solution code:', testCode);

    // Simple runner without restrictions
    const simpleRunner = `
import sys
import ast

sol_path = sys.argv[1]
src = open(sol_path).read()

ns = {}
try:
    exec(src, ns, ns)
    print("Compilation successful")
    
    # Test the function
    fn = ns.get('is_palindrome')
    if callable(fn):
        result = fn('racecar')
        print(f"Function call result: {result}")
        print("1/1")  # Success
    else:
        print("Function not found")
        print("0/1")
except Exception as e:
    print(f"Error: {e}")
    print("0/1")
`.trim();

    await fs.writeFile(runnerPath, simpleRunner);
    console.log('✅ Simple runner written');

    // Test with simple runner
    console.log('\n🧪 Testing with simple runner...');
    try {
      const { stdout, stderr } = await execAsync(`python3 ${runnerPath} ${solPath}`, { timeout: 5000 });
      console.log('📤 stdout:', stdout);
      if (stderr) console.log('📤 stderr:', stderr);
    } catch (e: any) {
      console.log('❌ Simple runner failed:', e.message);
      if (e.stdout) console.log('📤 stdout:', e.stdout);
      if (e.stderr) console.log('📤 stderr:', e.stderr);
    }

    // Now test with complex runner (similar to our production one)
    const complexRunner = `
import resource, signal, sys, builtins, ast

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (2,2))
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024,512*1024*1024))

def timeout_handler(sig,frame): 
    sys.exit(124)
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(5)

# Import restrictions
orig_import = builtins.__import__
def safe_import(name, *args, **kwargs):
    banned = {'os','subprocess','socket','urllib','requests','http','ftplib','smtplib','shutil','pathlib'}
    if name in banned:
        raise ImportError(f"Import '{name}' blocked")
    return orig_import(name, *args, **kwargs)
builtins.__import__ = safe_import

# File restrictions
orig_open = builtins.open
def safe_open(file, mode='r', *args, **kwargs):
    if 'w' in mode or 'a' in mode or '+' in mode: 
        raise PermissionError("File write blocked")
    if isinstance(file, str) and file.startswith(('/', '\\\\')):
        raise PermissionError("Absolute paths blocked")
    return orig_open(file, mode, *args, **kwargs)
builtins.open = safe_open

sol_path = sys.argv[1]
src = open(sol_path).read().replace('\\r\\n','\\n')

ns = {}
try:
    codeobj = compile(src, '<solution>', 'exec')
    exec(codeobj, ns, ns)
    print("Compilation successful")
    
    # Test the function
    fn = ns.get('is_palindrome')
    if callable(fn):
        result = fn('racecar')
        print(f"Function call result: {result}")
        print("1/1")
    else:
        print("Function not found")
        print("0/1")
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
    print("0/1")
`.trim();

    const complexRunnerPath = path.join(tmpDir, `debug_complex_runner_${Date.now()}.py`);
    await fs.writeFile(complexRunnerPath, complexRunner);

    console.log('\n🧪 Testing with complex runner (production-like)...');
    try {
      const { stdout, stderr } = await execAsync(`python3 ${complexRunnerPath} ${solPath}`, { timeout: 10000 });
      console.log('📤 stdout:', stdout);
      if (stderr) console.log('📤 stderr:', stderr);
    } catch (e: any) {
      console.log('❌ Complex runner failed:', e.message);
      if (e.stdout) console.log('📤 stdout:', e.stdout);
      if (e.stderr) console.log('📤 stderr:', e.stderr);
    }

  } catch (error) {
    console.error('❌ Debug test failed:', error);
  } finally {
    // Cleanup
    try {
      await fs.unlink(solPath);
      await fs.unlink(runnerPath);
      if (await fs.access(path.join(tmpDir, `debug_complex_runner_${Date.now() - 1000}.py`)).then(() => true).catch(() => false)) {
        await fs.unlink(path.join(tmpDir, `debug_complex_runner_${Date.now() - 1000}.py`));
      }
    } catch {}
  }
}

debugPythonRunner()
  .then(() => {
    console.log('\n✅ Python runner debug complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Debug failed:', error);
    process.exit(1);
  });
