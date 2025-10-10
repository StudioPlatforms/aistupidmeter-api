# AI Stupid Meter - API Server

🚀 **The World's First AI Intelligence Degradation Detection System - Backend**

A high-performance Fastify-based API server that provides comprehensive AI model benchmarking, degradation detection, intelligent routing, and advanced analytics capabilities.

## 🌟 Live API

- **Production API**: [https://aistupidlevel.info](https://aistupidlevel.info)
- **Documentation**: Available via API endpoints
- **Status**: 99.9% uptime with enterprise-grade reliability

## 🚀 Core Features

### 🔬 **Advanced Benchmarking System**
- **Dual-benchmark architecture**: Speed tests (4-hourly) + Deep reasoning (daily)
- **7-axis scoring methodology**: Correctness, Spec Compliance, Code Quality, Efficiency, Stability, Refusal Rate, Recovery
- **Statistical analysis**: CUSUM algorithms, Mann-Whitney U tests, change point detection
- **Confidence intervals**: 95% CI with 5-trial median scoring for reliability
- **25+ AI models tracked**: OpenAI GPT-5/O3, Claude Opus 4, Grok 4, Gemini 2.5 series

### 🧠 **Intelligence Degradation Detection**
- **Real-time monitoring** with automated alerts
- **29 warning categories** across 5 major detection types
- **CUSUM drift detection** for gradual performance changes
- **Statistical significance testing** (p < 0.05 confidence levels)
- **Provider reliability scoring** with incident tracking

### 🔧 **Revolutionary Tool Calling Benchmarks**
- **World-first tool calling evaluation system**
- **Secure sandbox execution** with Docker containers
- **Multi-step workflow testing** (execute-command, read-file, write-file, etc.)
- **171+ successful sessions** demonstrating practical AI capabilities
- **Real-world task completion** beyond text generation

### 🎯 **AI Router Pro System**
- **Intelligent model routing** based on real-time performance
- **Cost optimization** with automatic provider switching
- **Load balancing** across multiple API keys
- **Degradation protection** preventing poor model usage
- **Enterprise SLA** with 99.9% uptime guarantee

### 📊 **Advanced Analytics Engine**
- **Real-time recommendations** for best models by use case
- **Performance trend analysis** with historical tracking
- **Provider trust scores** and reliability metrics
- **Drift incident monitoring** with automated notifications
- **Cost-efficiency analysis** and optimization suggestions

### ⚡ **High-Performance Architecture**
- **Redis caching** for sub-100ms response times
- **PostgreSQL** with connection pooling and replication
- **Distributed computing** across 3 geographic regions
- **Kubernetes deployment** with auto-scaling
- **Rate limiting** and DDoS protection

## 📋 Prerequisites

- Node.js 18+
- npm or yarn
- PostgreSQL 14+
- Redis 6+
- Docker (for tool calling sandboxes)

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/StudioPlatforms/aistupidmeter-api.git
cd aistupidmeter-api
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your actual configuration
```

Required environment variables:
```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/aistupid
REDIS_URL=redis://localhost:6379

# AI Provider API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
XAI_API_KEY=xai-...

# Server Configuration
NODE_ENV=development
PORT=4000
HOST=0.0.0.0
JWT_SECRET=your-jwt-secret

# Router System
ROUTER_MASTER_KEY=your-master-key
ENCRYPTION_KEY=your-32-char-encryption-key

# External Services
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

4. Set up the database:
```bash
# Run migrations
npm run db:migrate

# Seed initial data
npm run db:seed
```

5. Build and start:
```bash
# Build TypeScript
npm run build

# Start production server
npm run start

# Or for development with hot reload
npm run dev
```

The API server will run on `http://localhost:4000`

## 📦 Available Scripts

- `npm run dev` - Development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run test` - Run test suite
- `npm run db:migrate` - Run database migrations
- `npm run db:seed` - Seed database with initial data
- `npm run lint` - Run ESLint
- `npm run type-check` - TypeScript type checking

## 🔌 API Endpoints

### **Dashboard & Analytics**
```
GET  /dashboard/cached          # Cached dashboard data (instant loading)
GET  /dashboard/scores          # Real-time model scores
GET  /dashboard/global-index    # Global AI intelligence index
GET  /dashboard/alerts          # Active performance alerts
GET  /dashboard/batch-status    # Batch processing status

GET  /analytics/degradations    # Performance degradation analysis
GET  /analytics/recommendations # Smart model recommendations
GET  /analytics/transparency    # Data transparency metrics
GET  /analytics/provider-reliability # Provider trust scores
```

### **Models & Benchmarks**
```
GET  /models                    # List all AI models
GET  /models/:id                # Individual model details
GET  /models/:id/history        # Historical performance data

POST /benchmark/trigger         # Manually trigger benchmarks
GET  /benchmark/status          # Benchmark execution status
GET  /benchmark/results         # Latest benchmark results
```

### **AI Router Pro**
```
POST /router/chat/completions   # Intelligent model routing
GET  /router/analytics          # Router performance metrics
GET  /router/keys               # API key management
POST /router/keys/generate      # Generate new router keys
GET  /router/providers          # Available AI providers
```

### **Tool Calling System**
```
POST /api/test-adapters/benchmark-test        # Run tool calling benchmark
POST /api/test-adapters/benchmark-test-stream # Streaming benchmark
GET  /api/test-adapters/benchmark-stream/:id  # Stream benchmark results
```

### **Health & Monitoring**
```
GET  /health                    # System health check
GET  /health/detailed           # Detailed system status
GET  /visitors/stats            # Visitor analytics
GET  /incidents                 # System incidents log
```

### **Authentication & Subscriptions**
```
POST /auth/login                # User authentication
POST /auth/register             # User registration
GET  /subscription/status       # Subscription status
POST /subscription/webhook      # Stripe webhook handler
```

## 🗄️ Database Schema

### **Core Tables**
- `models` - AI model configurations and metadata
- `benchmark_runs` - Individual benchmark execution records
- `scores` - Calculated performance scores with confidence intervals
- `tasks` - Benchmark task definitions and parameters
- `metrics` - Detailed performance metrics per run

### **Analytics Tables**
- `degradations` - Detected performance degradations
- `incidents` - System and model incidents
- `provider_stats` - Provider reliability metrics
- `recommendations` - Generated model recommendations

### **Router System**
- `router_keys` - Encrypted API key management
- `router_requests` - Request routing logs
- `router_analytics` - Performance analytics

### **Tool Calling**
- `tool_sessions` - Tool calling benchmark sessions
- `tool_executions` - Individual tool execution records
- `sandbox_logs` - Sandbox execution logs

## 🏗️ Tech Stack

### **Core Framework**
- **Fastify** - High-performance web framework
- **TypeScript** - Type-safe development
- **Drizzle ORM** - Type-safe database operations
- **PostgreSQL** - Primary database with replication

### **Performance & Caching**
- **Redis** - Caching and session management
- **Connection pooling** - Optimized database connections
- **Query optimization** - Indexed queries and materialized views
- **CDN integration** - Global content delivery

### **AI Integration**
- **OpenAI SDK** - GPT models integration
- **Anthropic SDK** - Claude models integration
- **Google AI SDK** - Gemini models integration
- **xAI SDK** - Grok models integration

### **Infrastructure**
- **Docker** - Containerized deployments
- **Kubernetes** - Container orchestration
- **PM2** - Process management
- **Nginx** - Reverse proxy and load balancing

### **Monitoring & Security**
- **JWT authentication** - Secure API access
- **Rate limiting** - DDoS protection
- **Error tracking** - Comprehensive logging
- **Health monitoring** - System status tracking

## 🔒 Security Features

- **API key encryption** - AES-256 encryption for stored keys
- **JWT token validation** - Secure authentication
- **Rate limiting** - Per-IP and per-user limits
- **Input sanitization** - SQL injection prevention
- **CORS configuration** - Cross-origin request security
- **Sandbox isolation** - Secure tool execution environment

## 📊 Performance Metrics

- **Response time**: < 100ms for cached endpoints
- **Throughput**: 10,000+ requests per minute
- **Uptime**: 99.9% SLA with monitoring
- **Cache hit ratio**: > 95% for dashboard data
- **Database queries**: Optimized with < 10ms average

## 🚀 Deployment

### **Production Deployment**
```bash
# Build for production
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# Or with Docker
docker build -t aistupid-api .
docker run -p 4000:4000 aistupid-api
```

### **Environment Configuration**
- **Development**: Local PostgreSQL + Redis
- **Staging**: Managed databases with replication
- **Production**: Multi-region deployment with failover

## 🔗 Related Repositories

- [AI Stupid Meter Web](https://github.com/StudioPlatforms/aistupidmeter-web) - Frontend application
- [Hugging Face Space](https://huggingface.co/spaces/AIStupidLevel/) - Interactive demo

## 🌍 Community

- **Reddit**: [r/AIStupidLevel](https://www.reddit.com/r/AIStupidlevel) - Community discussions
- **X/Twitter**: [@AIStupidlevel](https://x.com/AIStupidlevel) - Latest updates
- **GitHub Issues** - Bug reports and feature requests

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### **Development Workflow**
1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Set up development environment with Docker Compose
4. Make your changes and add tests
5. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
6. Push to the branch (`git push origin feature/AmazingFeature`)
7. Open a Pull Request

### **Code Standards**
- Follow TypeScript best practices
- Use ESLint and Prettier for code formatting
- Write comprehensive tests for new features
- Document API endpoints with OpenAPI/Swagger
- Follow semantic versioning for releases

### **Testing**
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:benchmark

# Test coverage
npm run test:coverage
```

## 📧 Contact

**Built by:** Laurent @ StudioPlatforms

- **X/Twitter:** [@goatgamedev](https://x.com/goatgamedev)
- **Email:** laurent@studio-blockchain.com
- **GitHub:** [StudioPlatforms](https://github.com/StudioPlatforms)
- **Website:** [https://studioplatforms.eu](https://studioplatforms.eu)

## 🙏 Acknowledgments

- **OpenAI, Anthropic, Google, xAI** for providing AI model APIs
- **Fastify team** for the excellent web framework
- **PostgreSQL & Redis** communities for robust data solutions
- **Docker & Kubernetes** for containerization platform
- **Community contributors** for feedback and improvements

---

**Project Links:**
- **Repository**: [https://github.com/StudioPlatforms/aistupidmeter-api](https://github.com/StudioPlatforms/aistupidmeter-api)
- **Live API**: [https://aistupidlevel.info](https://aistupidlevel.info)
- **Frontend**: [https://github.com/StudioPlatforms/aistupidmeter-web](https://github.com/StudioPlatforms/aistupidmeter-web)

*Last Updated: January 2025*
