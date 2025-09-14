import dotenv from 'dotenv';
dotenv.config({ path: '/root/.env' });

import { runDeepBenchmarks } from '../deepbench/index';

export { runDeepBenchmarks };

// This file provides a consistent job interface similar to real-benchmarks.ts
// It's mainly used for manual testing and providing a clean import path
