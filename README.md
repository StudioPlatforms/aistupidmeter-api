# AI Stupid Meter - API Server

A Fastify-based API server that benchmarks and evaluates AI models, calculating "stupidity scores" based on their performance across various programming tasks.

## 🚀 Features

- Real-time AI model benchmarking
- Multi-provider support (OpenAI, Anthropic, Google Gemini, xAI)
- Automated benchmark scheduling
- Performance metrics and analytics
- SQLite database with Drizzle ORM
- RESTful API endpoints
- Visitor tracking and analytics

## 📋 Prerequisites

- Node.js 18+
- npm or yarn
- SQLite3

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
# Edit .env with your actual API keys
```

4. Build the TypeScript code:
```bash
npm run build
```

5. Run database migrations/seed (if needed):
```bash
npx tsx seed-models.ts
npx tsx seed-benchmark-tasks.ts
```

6. Start the server:
```bash
npm run start
# Or for development:
npm run dev
```

The API server will run on `http://localhost:4000`

## 📦 Available Scripts

- `npm run dev` - Start development server with hot reload (tsx)
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server

## 🔌 API Endpoints

### Models
- `GET /models` - List all AI models
- `GET /models/active` - Get active models
- `GET /models/:id` - Get specific model details

### Benchmarks
- `GET /benchmark/history` - Get benchmark history
- `POST /benchmark/trigger` - Manually trigger benchmark run

### Dashboard
- `GET /dashboard/stats` - Get dashboard statistics
- `GET /dashboard/recent-runs` - Get recent benchmark runs

### Analytics
- `GET /analytics/stats` - Get analytics data
- `GET /analytics/visitors` - Get visitor statistics

### Reference
- `GET /reference/baseline` - Get baseline performance metrics

## 🗄️ Database Schema

The API uses SQLite with Drizzle ORM. Main tables include:
- `models` - AI model configurations
- `tasks` - Benchmark tasks
- `runs` - Benchmark run results
- `metrics` - Performance metrics
- `scores` - Calculated stupidity scores
- `visitors` - Visitor tracking

## 🔑 Environment Variables

```env
DATABASE_URL=./data/stupid_meter.db
OPENAI_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
XAI_API_KEY=your_key_here
NODE_ENV=development
PORT=4000
HOST=0.0.0.0
```

## 🏗️ Tech Stack

- **Framework**: Fastify
- **Database**: SQLite with Drizzle ORM
- **Language**: TypeScript
- **Scheduler**: node-cron
- **AI Providers**: OpenAI, Anthropic, Google Gemini, xAI

## 🔗 Related Repositories

- [AI Stupid Meter Web](https://github.com/StudioPlatforms/aistupidmeter-web) - Frontend application

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📧 Contact

**Built by:** Laurent @ StudioPlatforms

- **X/Twitter:** [@goatgamedev](https://x.com/goatgamedev)
- **Email:** laurent@studio-blockchain.com
- **GitHub:** [StudioPlatforms](https://github.com/StudioPlatforms)
- **Subreddit:** [r/AIStupidlevel](https://www.reddit.com/r/AIStupidlevel)

Project Link: [https://github.com/StudioPlatforms/aistupidmeter-api](https://github.com/StudioPlatforms/aistupidmeter-api)
