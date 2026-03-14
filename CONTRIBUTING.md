# Contributing to openclaw-obs

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/kkeeling/openclaw-obs.git
cd openclaw-obs
npm install
npm run build

cd dashboard
npm install
npm run build
cd ..
```

### Running in Development

```bash
# Watch mode for the plugin
npm run dev

# Dashboard dev server (hot reload)
cd dashboard && npm run dev
```

### Testing Changes

1. Link the plugin to your local OpenClaw: `openclaw plugins install --link .`
2. Restart the gateway: `openclaw gateway restart`
3. Trigger a session and check the dashboard at http://localhost:19100

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test against a running OpenClaw gateway
4. Submit a PR with a clear description of what changed and why

### Guidelines

- Keep PRs focused — one feature or fix per PR
- Follow existing code style (TypeScript strict, no `any` unless unavoidable)
- Update the README if you change configuration or add features
- No new runtime dependencies without discussion — we keep the footprint small

## Reporting Issues

Open a GitHub issue with:

- What you expected to happen
- What actually happened
- OpenClaw version, Node version, OS
- Relevant logs or screenshots

## Architecture

See the README for the project structure. Key principles:

- **Local-first** — no external services, no telemetry, no network calls
- **Minimal dependencies** — better-sqlite3 + express + React
- **Single process** — plugin + API + dashboard all in one
- **Buffer writes** — batch flush for performance, never block the gateway

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
