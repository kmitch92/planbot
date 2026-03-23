# Docker Sandboxing Plan

Status: **Draft** | Priority: **Low** | Last updated: 2026-03-23

## Problem

Planbot spawns `claude` / `opencode` as child processes with full host access. When running with `--skip-permissions --auto-approve`, the agent has unrestricted filesystem, network, and process capabilities. There is no mechanism to bound the blast radius of a misbehaving or adversarial execution.

## Goal

Allow users to optionally run planbot inside a Docker container so that all agent executions are isolated from the host system. Filesystem access is limited to explicit bind mounts, resource consumption is capped, and network access can be restricted.

## Scope

**In scope (Phase 1 — whole-process containerization):**
- Dockerfile for planbot + claude CLI
- docker-compose.yaml template with sensible defaults
- Documentation for setup and usage
- Resource limits (memory, CPU)
- Volume mount patterns for project files and credentials

**Out of scope (Phase 2 — future, if needed):**
- Per-ticket containerization (wrapping each `spawn("claude", ...)` in `docker run`)
- Custom `AgentProvider` implementation for Docker-wrapped execution
- Per-ticket resource limits or network policies

## Design

### Phase 1: Whole-Process Containerization

No production code changes. Ship a `Dockerfile`, `docker-compose.yaml`, and docs.

#### Dockerfile

- Base: `node:20-slim`
- Install claude CLI (`npm install -g @anthropic-ai/claude-code`)
- Install planbot from source or npm
- Non-root user for execution
- Working directory: `/workspace`

#### docker-compose.yaml

```yaml
services:
  planbot:
    build: .
    volumes:
      # Project files — the directory containing tickets.yaml
      - ./:/workspace
      # Claude auth — required for API access
      - ~/.claude:/home/node/.claude:ro
    working_dir: /workspace
    environment:
      - ANTHROPIC_API_KEY
      # Messaging (optional)
      - TELEGRAM_BOT_TOKEN
      - TELEGRAM_CHAT_ID
      - SLACK_BOT_TOKEN
      - SLACK_APP_TOKEN
      - DISCORD_BOT_TOKEN
    deploy:
      resources:
        limits:
          memory: 8g
          cpus: "4"
    # Restrict network access (uncomment to fully isolate)
    # network_mode: none
    stdin_open: true
    tty: true
```

#### Usage

```bash
# Build once
docker compose build

# Run planbot start inside the container
docker compose run planbot planbot start tickets.yaml --auto-approve

# Or interactive
docker compose run planbot planbot start -C
```

#### What This Bounds

| Concern | Host | Container |
|---------|------|-----------|
| Filesystem | Full access | Only bind-mounted dirs |
| Memory | Unbounded (planbot has soft limits) | Hard cgroup limit |
| CPU | Unbounded | Capped by cpus setting |
| Network | Full | Can be restricted or disabled |
| Processes | Full PID namespace | Isolated PID namespace |
| Host devices | Accessible | Not mounted |

### Phase 2: Per-Ticket Containerization (Future)

If Phase 1 proves insufficient (e.g., users want different isolation per ticket, or need to run untrusted ticket descriptions), this phase would:

1. Add `config.sandbox` schema field:
   ```yaml
   config:
     sandbox:
       enabled: true
       image: "planbot-sandbox:latest"
       memoryLimit: "4g"
       cpuLimit: "2"
       networkMode: "none"  # or "bridge"
       extraMounts: []
   ```

2. Create a `DockerAgentProvider` that wraps `AgentProvider`:
   - `spawn("claude", args, ...)` becomes `spawn("docker", ["run", "--rm", "-i", ...constraints, image, "claude", ...args])`
   - Bind-mount the ticket's `cwd` into the container
   - Map session storage for `--resume` / `--session-id` support

3. Ship a `planbot-sandbox` Docker image with claude CLI pre-installed.

**Complexity notes for Phase 2:**
- Session resumption requires shared volume for Claude's session store
- `--input-format stream-json` stdin piping works with `docker run -i`
- Container startup adds ~1-2s latency per ticket
- Hook shell commands would also need containerization consideration

## Open Questions

- Should the Dockerfile also support opencode agent? (Adds Python/Go dependency)
- Should we provide a `.dockerignore` to exclude `node_modules`, `.git`, etc. from the build context?
- Is `network_mode: none` too restrictive as a default for users who need messaging?
- Should Phase 1 include a `planbot docker` subcommand that wraps `docker compose run` for convenience?

## Implementation Steps

1. Create `Dockerfile`
2. Create `docker-compose.yaml`
3. Create `.dockerignore`
4. Add "Running in Docker" section to README
5. Test: basic ticket execution inside container
6. Test: messaging providers work with container networking
7. Test: resource limits trigger correctly (OOM behavior)
