# Appendix C: Complete Feature Flag Reference

Three categories of flags: compile-time (bundler macros, dead code elimination), runtime (remotely delivered, functionality can be toggled without shipping a new version), and environment variables (read at startup).

---

## C.1 Compile-Time Feature Flags

Determined at build time via compile-time macros. In external release builds, most internal-only flags are false and related code is completely eliminated.

### Permissions & Security

| Flag | Purpose |
|------|---------|
| BASH_CLASSIFIER | Bash command safety classifier; uses LLM to determine whether commands are safe |
| TRANSCRIPT_CLASSIFIER | Auto-mode safety classifier; evaluates based on full conversation context |
| ANTI_DISTILLATION | Anti-distillation protection; injects fake tools to prevent model distillation |
| NATIVE_CLIENT_ATTESTATION | Native client attestation (device trust) |
| POWERSHELL_AUTO_MODE | PowerShell auto-mode support |
| TREE_SITTER_BASH | Tree-sitter Bash parser (replaces legacy parser) |
| TREE_SITTER_BASH_SHADOW | Tree-sitter shadow mode (side-by-side comparison of old and new parsers) |

### Agent System

| Flag | Purpose |
|------|---------|
| BUILTIN_EXPLORE_PLAN_AGENTS | Built-in Explore/Plan Agents |
| VERIFICATION_AGENT | Verification Agent (automatic verification after plan execution) |
| COORDINATOR_MODE | Coordinator mode; main Agent acts as task coordinator |
| FORK_SUBAGENT | Fork-mode sub-Agent; quick-clones current context |
| AGENT_MEMORY_SNAPSHOT | Agent memory snapshot; initializes memory from project snapshot |
| AGENT_TRIGGERS | Scheduled triggers (cron); allows timed Agent execution |
| AGENT_TRIGGERS_REMOTE | Remote scheduled triggers; supports remote event-driven execution |

### Assistant Mode

| Flag | Purpose |
|------|---------|
| ASSISTANT_MODE | Assistant mode core (integrated full assistant experience) |
| ASSISTANT_BRIEF | Assistant mode brief view |
| ASSISTANT_CHANNELS | Multi-channel support (Telegram/iMessage etc.) |
| ASSISTANT_DREAM | Dream functionality (background autonomous thinking) |
| ASSISTANT_GITHUB_WEBHOOKS | GitHub Webhook integration (PR subscriptions) |
| ASSISTANT_PUSH_NOTIFICATION | Push notifications |
| PROACTIVE | Proactive mode (timer-driven background task execution) |
| AWAY_SUMMARY | Away summary; auto-generates conversation summary during user inactivity |

### Context Compression

| Flag | Purpose |
|------|---------|
| CACHED_MICROCOMPACT | Cache-friendly micro-compression; trims while preserving prompt cache |
| CONTEXT_COLLAPSE | Progressive context collapse; old messages replaced with placeholders |
| HISTORY_SNIP | Model can proactively trim old messages |
| REACTIVE_COMPACT | Reactive compression; real-time context growth rate monitoring |
| COMPACTION_REMINDERS | Preserves reminder information during compression |

### Remote & Bridge

| Flag | Purpose |
|------|---------|
| BRIDGE_MODE | Remote bridge mode (remote control) |
| REMOTE_AUTO_CONNECT | Remote auto-connect |
| REMOTE_MIRROR | Remote mirror mode; outbound event forwarding |
| REMOTE_SETUP | Remote setup command |
| DIRECT_CONNECT | Direct connect mode |
| SSH_REMOTE | SSH remote connection support |

### Tools & MCP

| Flag | Purpose |
|------|---------|
| COMPUTER_USE_MCP | Computer Use MCP (macOS desktop control) |
| MONITOR_TOOL | Monitor tool; background MCP server monitoring |
| MCP_RICH_OUTPUT | MCP rich text output rendering |
| MCP_SKILLS | MCP Skill discovery (load Skills from MCP resources) |
| WEB_BROWSER_TOOL | Web browser tool (embedded browser) |
| REVIEW_ARTIFACT | Code review artifact tool |
| TERMINAL_PANEL | Terminal panel (embedded terminal capture) |

### Memory & Skills

| Flag | Purpose |
|------|---------|
| EXTRACT_MEMORIES | Auto memory extraction; extracts valuable information at turn end |
| TEAM_MEMORY | Team memory (cross-Agent shared memory files) |
| MEMORY_SHAPE_TELEMETRY | Memory shape telemetry; analyzes memory file structure |
| EXPERIMENTAL_SKILL_SEARCH | Experimental remote Skill indexing and search |
| SKILL_IMPROVEMENT | Skill auto-improvement suggestions |
| BUILDING_APPS_SKILL | Building apps related built-in Skill |
| RUN_SKILL_GENERATOR | Skill generator execution support |
| TEMPLATES | Template system |

### UI & Interaction

| Flag | Purpose |
|------|---------|
| VOICE_MODE | Voice mode (voice input/output) |
| COMPANION | Companion feature (UI decorative sprite) |
| AUTO_THEME | Auto theme switching; follows system dark/light mode |
| MESSAGE_ACTIONS | Message actions (keyboard shortcut operations on messages) |
| HISTORY_PICKER | History message picker UI |
| QUICK_SEARCH | Quick search (keyboard-triggered) |
| NATIVE_CLIPBOARD_IMAGE | Native clipboard image paste |

### Telemetry & Debug

| Flag | Purpose |
|------|---------|
| ENHANCED_TELEMETRY_BETA | Enhanced telemetry beta (includes performance tracing) |
| PERFORMANCE_TRACING | Performance tracing |
| SHOT_STATS | Shot distribution statistics (zero-shot/few-shot analysis) |
| SLOW_OPERATION_LOGGING | Slow operation logging |
| HARD_FAIL | Hard fail mode; warnings escalated to fatal errors |
| DUMP_SYSTEM_PROMPT | Export system prompt |
| BREAK_CACHE_COMMAND | Cache break command; debug prompt cache |
| OVERFLOW_TEST_TOOL | Overflow test tool |

### Performance & API

| Flag | Purpose |
|------|---------|
| TOKEN_BUDGET | Token budget management; controls tool result token consumption |
| FILE_PERSISTENCE | Large tool results written to disk |
| PROMPT_CACHE_BREAK_DETECTION | Prompt cache break detection and diagnosis |
| CONNECTOR_TEXT | Connector Text content blocks (API beta) |
| ULTRATHINK | Ultra thinking mode (thinking enabled by default) |
| ULTRAPLAN | Remote large-scale plan execution |
| UNATTENDED_RETRY | Unattended retry (automatic retry on 429/529) |
| STREAMLINED_OUTPUT | Streamlined output mode |

### Deployment & System

| Flag | Purpose |
|------|---------|
| BG_SESSIONS | Background sessions |
| DAEMON | Daemon mode |
| BYOC_ENVIRONMENT_RUNNER | BYOC environment runner |
| SELF_HOSTED_RUNNER | Self-hosted runner |
| LOCAL_SERVICE_DISCOVERY | Local service discovery protocol registration |
| UDS_INBOX | Unix Domain Socket inbox (inter-process messaging) |
| WORKFLOW_SCRIPTS | Workflow script system |
| HOOK_PROMPTS | Hooks can prompt the user |
| COMMIT_ATTRIBUTION | Commit attribution; tracks AI-assisted code changes |
| ABLATION_BASELINE | A/B test baseline mode |
| ALLOW_TEST_VERSIONS | Allow installation of test versions |
| DOWNLOAD_USER_SETTINGS | Download remote user settings (sync read side) |
| UPLOAD_USER_SETTINGS | Upload user settings (sync write side) |
| NEW_INIT | New version of init command |

Approximately **89** compile-time flags in total.

---

## C.2 Runtime Feature Flags (Remotely Delivered)

Delivered via a remote configuration platform; functionality can be toggled without shipping a new version.

Retrieved via a cached read function (which may return stale values) or a blocking read function (blocks until the latest value is available).

### Core Feature Gates

| Flag Category | Purpose |
|---------------|---------|
| Channel features | Channels feature availability gate |
| Channel permissions | Channel permissions feature gate |
| Auto memory | Auto memory feature gate |
| Auto memory alternative | Auto memory alternative gate |
| Memory append | Memory append feature gate |
| Team memory | Team memory feature gate |
| Session memory | Session memory feature gate |
| Verification Agent | Verification Agent + Todo evidence gate |
| Built-in Agents | Built-in Explore/Plan Agent gate |

### API & Performance

| Flag Category | Purpose |
|---------------|---------|
| File persistence | File persistence configuration |
| One-time keys | One-Time-Key slot feature |
| Deep thinking | Ultrathink mode gate |
| JSON tools | JSON tool mode gate |
| File enhancement | File write/edit enhancement |
| Attribution header | Commit attribution header gate |
| Token budget | Token budget related configuration |

### Remote & Bridge

| Flag Category | Purpose |
|---------------|---------|
| Remote bridge | Remote Bridge feature gate |
| Remote mirror | Remote mirror mode gate |
| REPL Bridge V2 | REPL Bridge V2 gate |
| Remote auto-connect | Remote auto-connect gate |
| Remote setup | Remote setup command gate |
| Remote backend | Remote TUI backend gate |
| System init | Bridge system init gate |
| Multi-session | Remote multi-session gate |

### Assistant Mode & Voice

| Flag Category | Purpose |
|---------------|---------|
| Assistant brief mode | Assistant brief mode gate |
| Voice kill switch | Voice mode emergency kill switch (true = disabled) |
| Voice recognition enhanced | Voice recognition enhanced model gate |
| Remote triggers | Remote triggers gate |

### Classifiers & Permissions

| Flag Category | Purpose |
|---------------|---------|
| Auto mode config | Auto mode configuration (enabled/opt-in/disabled) |
| Parser shadow mode | Tree-sitter shadow mode gate |
| Destructive command warning | Destructive command warning gate |
| Anti-distillation config | Anti-distillation fake tool injection configuration |

### UI & Experience

| Flag Category | Purpose |
|---------------|---------|
| Prompt suggestions | Prompt suggestions feature gate |
| Terminal sidebar | Terminal sidebar gate |
| Terminal panel | Terminal panel runtime gate |
| Special UI mode | Special UI mode |
| Clipboard image | Native clipboard image gate |
| Plugin recommendation | Plugin prompt recommendation gate |
| Instant model command | Instant model command gate |

### Tools & Agents

| Flag Category | Purpose |
|---------------|---------|
| Tool strict mode | Tool strict mode gate |
| Sub-Agent streamline | Sub-Agent streamline config (kill switch) |
| Auto background Agent | Auto background Agent gate |
| Agent list | Agent list append gate |
| Tool search enhanced | Tool search enhancement gate |
| Agent Swarm | Agent Swarm gate |
| Skill improvement | Skill improvement gate |

### Compression & Context

| Flag Category | Purpose |
|---------------|---------|
| Reactive compact | Reactive compression gate |
| Memory extraction frequency | Memory extraction frequency configuration |
| Attachment config | Attachment related configuration |
| Session pruning | Session storage pruning gate |
| Message processing | Message processing related configuration |

### Other

| Flag Category | Purpose |
|---------------|---------|
| Prompt Cache TTL | Prompt Cache 1h TTL allowlist |
| Polling interval | Bridge polling interval configuration |
| Keep-Alive config | Disable Keep-Alive on ECONNRESET |
| Streaming fallback | Disable streaming-to-non-streaming fallback |
| Settings sync | Settings sync gate |
| Fast mode | Fast mode gate |
| Service discovery | Local service discovery runtime gate |
| Browser auto-enable | Chrome auto-enable gate |
| Browser MCP | Chrome MCP server gate |
| Enhanced tracing | Enhanced telemetry tracing gate |
| MCP instructions | MCP instructions delta gate |
| Background refresh throttle | Background refresh throttle milliseconds |
| Remote model config | Remote large-scale plan model configuration |

Approximately **60+** runtime flags in total.

---

## C.3 Environment Variable Flags

Prefixed with `AGENT_`, read from the shell environment at startup.

### API & Backend

| Environment Variable | Type | Purpose |
|---------------------|------|---------|
| `AGENT_API_BASE_URL` | string | Custom API base URL |
| `AGENT_USE_BEDROCK` | boolean | Use Amazon Bedrock |
| `AGENT_USE_VERTEX` | boolean | Use Google Vertex AI |
| `AGENT_USE_FOUNDRY` | boolean | Use Foundry |
| `AGENT_SKIP_BEDROCK_AUTH` | boolean | Skip Bedrock authentication |
| `AGENT_SKIP_VERTEX_AUTH` | boolean | Skip Vertex AI authentication |
| `AGENT_SKIP_FOUNDRY_AUTH` | boolean | Skip Foundry authentication |
| `AGENT_MAX_RETRIES` | number | API maximum retry count |
| `AGENT_MAX_OUTPUT_TOKENS` | number | Maximum output token count |
| `AGENT_EXTRA_BODY` | JSON | API request body extra parameters |
| `AGENT_EXTRA_METADATA` | JSON | API request metadata extra parameters |
| `AGENT_UNATTENDED_RETRY` | boolean | Unattended automatic retry on 429/529 |
| `AGENT_DISABLE_THINKING` | boolean | Disable extended thinking |
| `AGENT_DISABLE_ADAPTIVE_THINKING` | boolean | Disable adaptive thinking |
| `AGENT_DISABLE_NONSTREAMING_FALLBACK` | boolean | Disable non-streaming fallback |
| `AGENT_ADDITIONAL_PROTECTION` | string | Additional security protection configuration |

### Remote & Deployment

| Environment Variable | Type | Purpose |
|---------------------|------|---------|
| `AGENT_REMOTE` | boolean | Remote mode identifier |
| `AGENT_REMOTE_SESSION_ID` | string | Remote session ID |
| `AGENT_CONTAINER_ID` | string | Container ID |
| `AGENT_REMOTE_MEMORY_DIR` | string | Remote mode memory directory path |
| `AGENT_ENTRYPOINT` | string | Entry point identifier (cli/sdk-ts/sdk-py/local-agent/desktop) |

### Feature Switches

| Environment Variable | Type | Purpose |
|---------------------|------|---------|
| `AGENT_SIMPLE` | boolean | Simple mode (`--bare`); disables advanced features |
| `AGENT_PROACTIVE` | boolean | Enable proactive mode |
| `AGENT_COORDINATOR_MODE` | boolean | Enable Coordinator mode |
| `AGENT_VERIFY_PLAN` | boolean | Enable plan verification |
| `AGENT_DISABLE_AUTO_MEMORY` | boolean | Disable auto memory |
| `AGENT_BUBBLEWRAP` | boolean | Enable Bubblewrap sandbox |
| `AGENT_ENABLE_PROMPT_SUGGESTION` | boolean | Enable prompt suggestions |

### Session & Output

| Environment Variable | Type | Purpose |
|---------------------|------|---------|
| `AGENT_RESUME_INTERRUPTED_TURN` | boolean | Resume interrupted turn |
| `AGENT_EXIT_AFTER_FIRST_RENDER` | boolean | Exit after first render (for testing) |
| `AGENT_STREAMLINED_OUTPUT` | boolean | Streamlined output format |
| `AGENT_MESSAGING_SOCKET` | string | UDS messaging socket path |
| `AGENT_ABLATION_BASELINE` | boolean | Ablation experiment mode |

### Performance & Plugins

| Environment Variable | Type | Purpose |
|---------------------|------|---------|
| `AGENT_AUTO_COMPACT_WINDOW` | number | Auto-compact token window threshold |
| `AGENT_BLOCKING_LIMIT_OVERRIDE` | number | Blocking limit override |
| `AGENT_FRAME_TIMING_LOG` | string | Frame timing log path |
| `AGENT_SYNC_PLUGIN_INSTALL` | boolean | Synchronous plugin install (blocks startup) |
| `AGENT_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | number | Synchronous plugin install timeout |

Approximately **41** environment variables in total.

---

## C.4 Flag Interaction Patterns

### Dual-Gate Pattern

Many features are simultaneously controlled by compile-time + runtime flags. Compile-time determines whether the code exists; runtime determines whether it is activated:

```pseudocode
// Voice mode: triple-gated
COMPILE_FLAG('VOICE_MODE')           // Is the code included?
  + runtime_voice_killswitch         // Emergency kill switch
  + hasVoiceAuth()                   // Runtime authentication

// Safety classifier: dual-gated
COMPILE_FLAG('TRANSCRIPT_CLASSIFIER') // Is classifier code included?
  + runtime_auto_mode_config          // Auto mode configuration

// Memory extraction: triple-gated
COMPILE_FLAG('EXTRACT_MEMORIES')      // Is memory extraction code included?
  + runtime_memory_gate               // Runtime gate
  + ENV_DISABLE_AUTO_MEMORY           // Environment variable disable
```

### Mutual Exclusion

```pseudocode
USE_BEDROCK  <=>  USE_VERTEX    // Choose one
SIMPLE = true  =>  Disables custom Agents, advanced tools, Coordinator
```

### Internal/External Build Differences

The same codebase compiles into versions with different feature sets via compile-time macros:

- **External build**: Assistant mode/voice mode/bridge mode/coordinator mode/team memory etc. = false
- **Internal build**: All flags available, internal user identifier enabled

---

[← Back to Contents](../README.md)
