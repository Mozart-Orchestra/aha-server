# Aha Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Aha?

Aha Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed
- ⭐ **Role & Rating System** - 大众点评 style role and team ratings

## Role & Rating System

Aha Server includes a comprehensive Role & Rating system inspired by 大众点评 (Chinese review platform):

### Role Templates (22 Built-in)

The server provides 22 default role templates across 6 categories:

| Category | Roles |
|----------|-------|
| Management | Master, Orchestrator, Project Manager, Product Owner, Business Analyst |
| Engineering | Architect, Solution Architect, Builder, Implementer, Framer |
| Quality | QA Engineer, QA, Reviewer |
| Research | Researcher, Scout |
| Support | Observer, Scribe, Technical Writer, Spec Writer |
| Design | Product Designer, UX Designer, UX Researcher |

### API Endpoints

#### Role Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/roles/defaults` | Get server-provided role templates |
| GET | `/v1/roles/pool` | Get public role pool |
| GET | `/v1/roles/library` | Get defaults + custom + pool |
| GET | `/v1/roles` | List user's custom roles |
| GET | `/v1/roles/:id` | Get single role |
| POST | `/v1/roles` | Create custom role |
| PUT | `/v1/roles/:id` | Update custom role |
| DELETE | `/v1/roles/:id` | Delete custom role |

#### Reviews & Ratings

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/roles/:id/reviews` | Submit role review |
| GET | `/v1/roles/:id/reviews` | Get role reviews |
| POST | `/v1/teams/:teamId/reviews` | Submit team review |
| GET | `/v1/teams/:teamId/reviews` | Get team reviews |
| GET | `/v1/teams/:teamId/score` | Get team scorecard |

#### Rating Records

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/ratings` | Create rating record |
| POST | `/v1/ratings/system/calculate` | Calculate system auto-rating |
| GET | `/v1/ratings/system/role/:roleId` | Get role system rating |
| GET | `/v1/ratings/:teamId` | Get team rating history |
| GET | `/v1/ratings/:teamId/role/:roleId` | Get role rating in team |
| GET | `/v1/ratings/:teamId/analytics` | Get team rating analytics |

### Rating Sources

The system supports three rating sources:
- **user** - User-submitted ratings
- **master** - Master/lead ratings
- **system** - Automated system ratings based on metrics

### System Rating Algorithm

The auto-rating algorithm calculates scores based on:
- **Code Lines** - Volume of code delivered
- **Commits** - Number of commits
- **Bug Count** - Bug fixes/introductions
- **Files Changed** - Scope of changes
- **Review Comments** - Code review engagement
- **Test Coverage** - Test coverage percentage

## How It Works

Your Claude Code clients generate encryption keys locally and use Aha Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Hosting

**You don't need to self-host!** Our free cloud Aha Server at `aha-api.slopus.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Aha Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own.

## License

MIT - Use it, modify it, deploy it anywhere.