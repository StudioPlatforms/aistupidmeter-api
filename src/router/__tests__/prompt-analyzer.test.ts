/**
 * Unit Tests for Prompt Analyzer
 * 
 * Tests language detection, task type detection, framework detection,
 * and complexity estimation
 */

import { describe, it, expect } from '@jest/globals';
import { 
  analyzePrompt, 
  getAnalysisSummary, 
  hasExplicitLanguageRequest 
} from '../analyzer/prompt-analyzer';

describe('Prompt Analyzer', () => {
  
  describe('Language Detection', () => {
    it('should detect Python from keywords', () => {
      const result = analyzePrompt('Write a Python function to sort a list');
      expect(result.language).toBe('python');
      expect(result.confidence).toBeGreaterThan(0.7);
    });
    
    it('should detect JavaScript from keywords', () => {
      const result = analyzePrompt('Create a JavaScript function using npm packages');
      expect(result.language).toBe('javascript');
    });
    
    it('should detect TypeScript from type hints', () => {
      const result = analyzePrompt('Write a TypeScript interface for user data');
      expect(result.language).toBe('typescript');
    });
    
    it('should detect Rust from ownership keywords', () => {
      const result = analyzePrompt('Implement a Rust function with ownership and borrowing');
      expect(result.language).toBe('rust');
    });
    
    it('should detect Go from goroutine keywords', () => {
      const result = analyzePrompt('Create a Go program with goroutines and channels');
      expect(result.language).toBe('go');
    });
    
    it('should detect language from file extensions', () => {
      const result = analyzePrompt('Fix the bug in main.rs file');
      expect(result.language).toBe('rust');
      expect(result.detectionReasons).toContain('File extension detected: rust');
    });
    
    it('should default to Python when unclear', () => {
      const result = analyzePrompt('Write a function to calculate fibonacci');
      expect(result.language).toBe('python');
      expect(result.detectionReasons).toContain('Defaulting to Python (most common)');
    });
  });
  
  describe('Task Type Detection', () => {
    it('should detect UI tasks', () => {
      const result = analyzePrompt('Create a React component with a button and form');
      expect(result.taskType).toBe('ui');
      expect(result.detectionReasons).toContain('UI/Frontend keywords detected');
    });
    
    it('should detect algorithm tasks', () => {
      const result = analyzePrompt('Implement binary search on a sorted array');
      expect(result.taskType).toBe('algorithm');
      expect(result.detectionReasons).toContain('Algorithm keywords detected');
    });
    
    it('should detect backend tasks', () => {
      const result = analyzePrompt('Create a REST API endpoint for user authentication');
      expect(result.taskType).toBe('backend');
      expect(result.detectionReasons).toContain('Backend/API keywords detected');
    });
    
    it('should detect debug tasks', () => {
      const result = analyzePrompt('Debug this error in the authentication flow');
      expect(result.taskType).toBe('debug');
      expect(result.detectionReasons).toContain('Debugging keywords detected');
    });
    
    it('should detect refactor tasks', () => {
      const result = analyzePrompt('Refactor this code to improve readability');
      expect(result.taskType).toBe('refactor');
      expect(result.detectionReasons).toContain('Refactoring keywords detected');
    });
    
    it('should default to general for unclear tasks', () => {
      const result = analyzePrompt('Help me with this');
      expect(result.taskType).toBe('general');
    });
  });
  
  describe('Framework Detection', () => {
    it('should detect React', () => {
      const result = analyzePrompt('Create a React component with useState hook');
      expect(result.framework).toBe('react');
      expect(result.detectionReasons).toContain('Framework detected: react');
    });
    
    it('should detect Vue', () => {
      const result = analyzePrompt('Build a Vue component with v-if directive');
      expect(result.framework).toBe('vue');
    });
    
    it('should detect Next.js', () => {
      const result = analyzePrompt('Create a Next.js page with getServerSideProps');
      expect(result.framework).toBe('nextjs');
    });
    
    it('should detect Django', () => {
      const result = analyzePrompt('Create a Django model for user profiles');
      expect(result.framework).toBe('django');
    });
    
    it('should detect Flask', () => {
      const result = analyzePrompt('Build a Flask route with @app.route decorator');
      expect(result.framework).toBe('flask');
    });
    
    it('should detect Express', () => {
      const result = analyzePrompt('Create an Express middleware for authentication');
      expect(result.framework).toBe('express');
    });
    
    it('should return undefined for no framework', () => {
      const result = analyzePrompt('Write a simple function');
      expect(result.framework).toBeUndefined();
    });
  });
  
  describe('Complexity Estimation', () => {
    it('should detect simple tasks', () => {
      const result = analyzePrompt('Write a function to add two numbers');
      expect(result.complexity).toBe('simple');
    });
    
    it('should detect medium complexity', () => {
      const result = analyzePrompt('Create a REST API with authentication and user management');
      expect(result.complexity).toBe('medium');
    });
    
    it('should detect complex tasks from keywords', () => {
      const result = analyzePrompt('Build a distributed microservice architecture with async processing, security, and performance optimization');
      expect(result.complexity).toBe('complex');
      expect(result.detectionReasons).toContain('Architectural complexity');
      expect(result.detectionReasons).toContain('Security requirements');
      expect(result.detectionReasons).toContain('Performance optimization');
    });
    
    it('should detect complex tasks from length', () => {
      const longPrompt = 'Write a function that ' + 'does something '.repeat(30);
      const result = analyzePrompt(longPrompt);
      expect(result.complexity).toBe('complex');
    });
  });
  
  describe('Confidence Scoring', () => {
    it('should have high confidence with clear signals', () => {
      const result = analyzePrompt('Create a React component in TypeScript with authentication');
      expect(result.confidence).toBeGreaterThan(0.8);
    });
    
    it('should have lower confidence with vague prompts', () => {
      const result = analyzePrompt('Help me');
      expect(result.confidence).toBeLessThan(0.6);
    });
    
    it('should boost confidence for file extensions', () => {
      const result = analyzePrompt('Fix bug in main.py');
      expect(result.confidence).toBeGreaterThan(0.8);
    });
    
    it('should boost confidence for framework detection', () => {
      const result = analyzePrompt('Create a React component');
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });
  
  describe('Keyword Extraction', () => {
    it('should extract meaningful keywords', () => {
      const result = analyzePrompt('Create a React component for user authentication with JWT tokens');
      expect(result.keywords).toContain('react');
      expect(result.keywords).toContain('component');
      expect(result.keywords).toContain('authentication');
      expect(result.keywords).toContain('tokens');
    });
    
    it('should filter out common words', () => {
      const result = analyzePrompt('Write a function that does something');
      expect(result.keywords).not.toContain('write');
      expect(result.keywords).not.toContain('function');
      expect(result.keywords).not.toContain('that');
    });
    
    it('should limit to top 10 keywords', () => {
      const longPrompt = 'keyword1 keyword2 keyword3 keyword4 keyword5 keyword6 keyword7 keyword8 keyword9 keyword10 keyword11 keyword12';
      const result = analyzePrompt(longPrompt);
      expect(result.keywords.length).toBeLessThanOrEqual(10);
    });
  });
  
  describe('Explicit Language Requests', () => {
    it('should detect explicit Python request', () => {
      const result = hasExplicitLanguageRequest('Write this in Python');
      expect(result.hasRequest).toBe(true);
      expect(result.language).toBe('python');
    });
    
    it('should detect explicit JavaScript request', () => {
      const result = hasExplicitLanguageRequest('Using JavaScript, create a function');
      expect(result.hasRequest).toBe(true);
      expect(result.language).toBe('javascript');
    });
    
    it('should detect explicit TypeScript request', () => {
      const result = hasExplicitLanguageRequest('Write TypeScript code for this');
      expect(result.hasRequest).toBe(true);
      expect(result.language).toBe('typescript');
    });
    
    it('should return false for no explicit request', () => {
      const result = hasExplicitLanguageRequest('Create a function');
      expect(result.hasRequest).toBe(false);
    });
  });
  
  describe('Analysis Summary', () => {
    it('should generate readable summary', () => {
      const analysis = analyzePrompt('Create a React component in TypeScript');
      const summary = getAnalysisSummary(analysis);
      
      expect(summary).toContain('Language: typescript');
      expect(summary).toContain('Task: ui');
      expect(summary).toContain('Framework: react');
      expect(summary).toContain('Complexity:');
      expect(summary).toContain('Confidence:');
    });
    
    it('should omit framework if not detected', () => {
      const analysis = analyzePrompt('Write a simple function');
      const summary = getAnalysisSummary(analysis);
      
      expect(summary).not.toContain('Framework:');
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle empty prompts', () => {
      const result = analyzePrompt('');
      expect(result.language).toBe('python'); // Default
      expect(result.taskType).toBe('general');
      expect(result.confidence).toBeLessThan(0.5);
    });
    
    it('should handle very short prompts', () => {
      const result = analyzePrompt('help');
      expect(result.confidence).toBeLessThan(0.5);
    });
    
    it('should handle mixed language signals', () => {
      const result = analyzePrompt('Convert this Python code to JavaScript');
      // Should detect the target language (JavaScript)
      expect(['python', 'javascript']).toContain(result.language);
    });
    
    it('should handle special characters', () => {
      const result = analyzePrompt('Create a function with @decorators and #comments');
      expect(result).toBeDefined();
      expect(result.language).toBeDefined();
    });
  });
  
  describe('Real-World Examples', () => {
    it('should correctly analyze React todo app request', () => {
      const result = analyzePrompt(
        'Create a React component for a todo list with add, delete, and toggle functionality'
      );
      
      expect(result.language).toBe('javascript');
      expect(result.taskType).toBe('ui');
      expect(result.framework).toBe('react');
      expect(result.complexity).toBe('medium');
      expect(result.confidence).toBeGreaterThan(0.8);
    });
    
    it('should correctly analyze algorithm request', () => {
      const result = analyzePrompt(
        'Implement a binary search tree in Python with insert, delete, and search operations'
      );
      
      expect(result.language).toBe('python');
      expect(result.taskType).toBe('algorithm');
      expect(result.complexity).toBe('medium');
    });
    
    it('should correctly analyze API request', () => {
      const result = analyzePrompt(
        'Build a REST API in Express with JWT authentication and PostgreSQL database'
      );
      
      expect(result.language).toBe('javascript');
      expect(result.taskType).toBe('backend');
      expect(result.framework).toBe('express');
      expect(result.complexity).toBe('complex');
    });
    
    it('should correctly analyze debug request', () => {
      const result = analyzePrompt(
        'Debug this TypeScript error: Property does not exist on type'
      );
      
      expect(result.language).toBe('typescript');
      expect(result.taskType).toBe('debug');
    });
  });
});
