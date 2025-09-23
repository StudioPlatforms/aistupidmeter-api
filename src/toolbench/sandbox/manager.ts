// Docker Sandbox Manager for Tool Execution
// Provides isolated environments for safe tool execution

import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export interface SandboxConfig {
  image?: string;
  workingDir?: string;
  timeoutMs?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  networkAccess?: boolean;
  mountPaths?: Record<string, string>; // host:container
  environment?: Record<string, string>;
}

export interface SandboxInfo {
  id: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  workingDir: string;
  createdAt: Date;
  config: SandboxConfig;
}

export class DockerSandboxManager {
  private sandboxes = new Map<string, SandboxInfo>();
  private readonly defaultConfig: Required<SandboxConfig> = {
    image: 'ubuntu:22.04',
    workingDir: '/workspace',
    timeoutMs: 300000, // 5 minutes
    memoryLimit: '512m',
    cpuLimit: '1.0',
    networkAccess: false,
    mountPaths: {},
    environment: {
      DEBIAN_FRONTEND: 'noninteractive',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
  };

  async createSandbox(config: SandboxConfig = {}): Promise<string> {
    const sandboxId = this.generateSandboxId();
    const finalConfig = { ...this.defaultConfig, ...config };
    
    const sandboxInfo: SandboxInfo = {
      id: sandboxId,
      status: 'creating',
      workingDir: finalConfig.workingDir,
      createdAt: new Date(),
      config: finalConfig
    };

    this.sandboxes.set(sandboxId, sandboxInfo);

    try {
      // Create container with security restrictions
      const createArgs = [
        'run', '-d',
        '--name', sandboxId,
        '--memory', finalConfig.memoryLimit,
        '--cpus', finalConfig.cpuLimit,
        '--security-opt', 'no-new-privileges:true',
        '--cap-drop', 'ALL',
        '--cap-add', 'DAC_OVERRIDE', // Allow file operations
        '--read-only', // Read-only root filesystem
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=100m',
        '--tmpfs', '/workspace:rw,noexec,nosuid,size=500m',
        '--workdir', finalConfig.workingDir,
        '--rm', // Auto-remove when stopped
      ];

      // Add network isolation if disabled
      if (!finalConfig.networkAccess) {
        createArgs.push('--network', 'none');
      }

      // Add environment variables
      for (const [key, value] of Object.entries(finalConfig.environment)) {
        createArgs.push('-e', `${key}=${value}`);
      }

      // Add mount paths
      for (const [hostPath, containerPath] of Object.entries(finalConfig.mountPaths)) {
        createArgs.push('-v', `${hostPath}:${containerPath}:ro`);
      }

      createArgs.push(finalConfig.image);
      createArgs.push('sleep', '3600'); // Keep container alive

      await this.executeDockerCommand(createArgs);
      
      // Wait a moment for container to be fully ready
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify container is running by checking its status
      try {
        const { stdout } = await this.executeDockerCommand(['inspect', '--format', '{{.State.Status}}', sandboxId]);
        if (stdout.trim() !== 'running') {
          throw new Error(`Container is not running: ${stdout.trim()}`);
        }
      } catch (error) {
        throw new Error(`Container status check failed: ${error}`);
      }

      sandboxInfo.status = 'running';
      return sandboxId;
    } catch (error) {
      sandboxInfo.status = 'error';
      throw new Error(`Failed to create sandbox: ${error}`);
    }
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`);
    }

    try {
      // Stop and remove container
      await this.executeDockerCommand(['stop', sandboxId]);
      sandbox.status = 'stopped';
      this.sandboxes.delete(sandboxId);
    } catch (error) {
      // Container might already be stopped/removed
      this.sandboxes.delete(sandboxId);
    }
  }

  async executeInSandbox(
    sandboxId: string,
    command: string[],
    options: { timeoutMs?: number; workingDir?: string } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || sandbox.status !== 'running') {
      throw new Error(`Sandbox ${sandboxId} is not running`);
    }

    const execArgs = ['exec'];
    
    if (options.workingDir) {
      execArgs.push('-w', options.workingDir);
    }
    
    execArgs.push(sandboxId, 'sh', '-c', command.join(' '));

    const timeoutMs = options.timeoutMs || sandbox.config.timeoutMs || 30000;
    
    return this.executeDockerCommand(execArgs, timeoutMs);
  }

  async writeFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || sandbox.status !== 'running') {
      throw new Error(`Sandbox ${sandboxId} is not running`);
    }

    // Use cat with here-document to write content exactly as-is
    // This avoids all shell escaping issues by using EOF delimiter
    const writeCommand = `cat > '${filePath}' << 'TOOLBENCH_EOF'\n${content}\nTOOLBENCH_EOF`;
    
    const result = await this.executeInSandbox(sandboxId, ['sh', '-c', writeCommand]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file ${filePath}: ${result.stderr}`);
    }
  }

  async readFile(sandboxId: string, filePath: string): Promise<string> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || sandbox.status !== 'running') {
      throw new Error(`Sandbox ${sandboxId} is not running`);
    }

    // Use docker exec to read file directly instead of copying
    const result = await this.executeInSandbox(sandboxId, ['cat', filePath]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${filePath}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async listFiles(sandboxId: string, dirPath: string = '.'): Promise<string[]> {
    const result = await this.executeInSandbox(sandboxId, ['ls', '-la', dirPath]);
    return result.stdout.split('\n').filter(line => line.trim());
  }

  getSandboxInfo(sandboxId: string): SandboxInfo | undefined {
    return this.sandboxes.get(sandboxId);
  }

  getAllSandboxes(): SandboxInfo[] {
    return Array.from(this.sandboxes.values());
  }

  async cleanupExpiredSandboxes(): Promise<void> {
    const now = new Date();
    const expiredSandboxes = Array.from(this.sandboxes.values()).filter(
      sandbox => now.getTime() - sandbox.createdAt.getTime() > 3600000 // 1 hour
    );

    for (const sandbox of expiredSandboxes) {
      try {
        await this.destroySandbox(sandbox.id);
      } catch (error) {
        console.error(`Failed to cleanup sandbox ${sandbox.id}:`, error);
      }
    }
  }

  private generateSandboxId(): string {
    return `toolbench_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private executeDockerCommand(
    args: string[],
    timeoutMs: number = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const process = spawn('docker', args);
      let stdout = '';
      let stderr = '';
      let isResolved = false;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          process.kill('SIGKILL');
          reject(new Error(`Docker command timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: code || 0 });
        }
      });

      process.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }
}

// Global sandbox manager instance
export const sandboxManager = new DockerSandboxManager();
