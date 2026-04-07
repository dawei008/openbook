# Chapter 18: MCP -- The Protocol for Connecting to the Outside World

> What is the ceiling for an Agent that can only read, write files, and execute commands?

```
     ┌──────────────────┐
     │   Agent Loop      │
     │   ┌─────┐         │
     │   │ LLM │         │
     │   └──┬──┘         │
     │   tool_use        │
     │      │            │
     │ ★ MCP Client ★   │  ◄── Focus of this chapter
     │   ┌──┴──┐         │
     │   │Proto│         │
     └───┴──┬──┴─────────┘
        ┌───┼───┐
        ▼   ▼   ▼
      stdio http  sse
        │    │     │
     [Local] [Remote Servers]
     Server  GitHub Slack DB
```

## 18.1 The Problem: The Capability Boundary of an Agent

Imagine you are using an AI Agent to perform a complete code review. It reads the code, identifies issues, and writes a fix. Then what?

You need it to create a GitHub PR. It cannot. You need it to notify the team on Slack. It cannot. You need it to query user data in a database to verify whether the fix is correct. It still cannot.

The core contradiction is this: the Agent's built-in tools (Read, Write, Bash) give it the ability to operate on the local filesystem, but modern development workflows depend on an entire web of SaaS services, APIs, and databases. The Agent needs a pathway to this external world.

The intuitive approach is to write a dedicated tool for each service. But this does not scale -- one for GitHub, one for Slack, one for Jira, one for each database -- and you quickly end up with a pile of tightly coupled "connectors."

MCP (Model Context Protocol) inverts this approach: rather than having the Agent adapt to each service, it defines a standard protocol and lets each service adapt to the Agent. This is like the USB interface for peripherals: you do not need to design a separate interface for mice, keyboards, and cameras -- a single unified standard suffices.

At the protocol level, MCP follows a Client-Server architecture. The Agent system acts as the Client, and external tool providers implement Servers. Servers expose three categories of capabilities through the protocol: Tools (callable functions), Resources (readable data sources), and Prompts (predefined conversation templates). The Client is responsible for discovery, connection, invocation, and relaying results back to the model.

But if your understanding stops here, you will underestimate the engineering complexity of MCP in this system. The truly difficult questions are: how does a single protocol accommodate both local subprocesses and remote HTTPS services? How is authentication made enterprise-grade? When a dozen MCP Servers are connected simultaneously, how is configuration managed?


## 18.2 The Transport Layer: Why So Many Connection Methods

The transport type enumeration in the MCP type definition module lists six transport methods (plus an internal proxy type). At first glance this seems confusing -- why not just use HTTP universally?

The answer lies in the diversity of use cases. A local SQLite query tool and a remote GitHub API service have entirely different requirements for process management, network connectivity, and authentication. Unifying the transport would make simple things needlessly complex.

**stdio** handles local subprocess communication. Configuration requires only a command and args; the type field is even optional -- if omitted it defaults to stdio, a backward-compatibility consideration. A noteworthy detail during connection: stderr is set to `'pipe'`. If the MCP Server's error output printed directly to the terminal, it would disrupt the Agent's TUI interface. stderr is also monitored and accumulated into a 64MB buffer, providing diagnostic information when connections fail. Process startup for stdio also supports specifying a shell prefix command via environment variables -- in containerized environments, the MCP Server launch can be wrapped with prefix commands like `docker exec`.

**http** is MCP's latest remote transport -- Streamable HTTP. The MCP client module defines a critical HTTP Accept constant: every POST request must declare acceptance of both JSON and SSE formats. Non-compliance results in a 406 from strict Servers. This is not arbitrary -- it allows the Server to return JSON for short responses and SSE for streaming responses, adapting two modes over a single connection. A request wrapper function with timeout attaches a 60-second timeout to every POST request, but no timeout to GET requests -- because in MCP transport, GET requests are long-lived SSE streams that should not be cut short by timeouts.

**sse** was the remote transport method before http arrived, receiving server pushes over HTTP long-polling connections. Configuration supports headers (static request headers), headersHelper (external programs that dynamically generate request headers), and oauth (OAuth authentication), making it the most common choice for remote Servers.

**ws** provides WebSocket full-duplex communication, suitable for high-frequency bidirectional interaction. **sdk** is in-process transport -- when the Agent is embedded in another application as an SDK, the MCP Server runs in the same process. **sse-ide and ws-ide** are designed for VS Code and similar IDE extensions, carrying additional metadata like ideName and ideRunningInWindows.

The design philosophy behind this transport diversity is: unify the protocol layer (JSON-RPC), adapt the transport layer. Just as TCP/IP does not care whether you are using fiber optic or Wi-Fi.


## 18.3 The Connection State Machine: Precise Reporting Across Five States

Each MCP Server connection is not a simple "connected" or "not connected." The type definition module defines five states: `connected` (holding a client instance and capabilities), `failed` (carrying error information), `needs-auth` (authentication required), `pending` (awaiting connection, with reconnection count), and `disabled` (manually disabled by the user).

Why this level of detail? Because the UI needs to tell the user precisely what is happening. "Connection failed" and "authentication required" are two completely different situations -- the former might be a network issue; the latter requires the user to authorize in a browser. The pending state carries `reconnectAttempt` and `maxReconnectAttempts`, enabling the UI to display progress like "Reconnecting (3/5)."

The connected state stores not just the client instance but also the Server's `capabilities` (which protocol features it supports), `serverInfo` (name and version), and `instructions` (the Server's self-description). This metadata lets the system adapt based on the Server's declarations -- for example, sending user interaction requests only to Servers that support the elicitation capability.

The state transition paths are: `pending` -> `connected` / `failed` / `needs-auth`, and `connected` -> `pending` (reconnection on disconnect). `disabled` is a terminal state that can only be restored manually by the user.

The union type design of the five states is worth noting. Each state carries different fields: connected has client and capabilities; failed has error; pending has reconnectAttempt. TypeScript's union types force callers to use type guards (`if (conn.type === 'connected')`) before accessing state-specific fields, allowing the compiler to catch incorrect field access at compile time.


## 18.4 Establishing a Connection: From Self-Introduction to Tool Discovery

The connection process is concentrated in the MCP client module. The key steps merit individual examination.

**Client self-introduction.** The Client declares its identity and exposes two capabilities: `roots` (informing the Server of the working directory) and `elicitation` (supporting the Server in requesting information from the user). Note that elicitation's value is an empty object `{}` rather than `{form:{},url:{}}` -- comments explicitly state that the latter causes certain Java MCP SDK implementations (Spring AI) to crash. This is the price of ecosystem compatibility -- there is always a gap between protocol specification and actual implementation.

**Working directory announcement.** When the Server requests ListRoots, the Client returns the current project path. This lets the Server know which codebase the user is working with, enabling context-relevant services.

**Timeout race.** Connection uses a `Promise.race` pattern -- whichever of connect or timeout completes first determines the outcome. The default timeout is configurable. After a timeout, the transport is proactively closed to prevent half-dead connections from consuming resources. For HTTP transports, a basic connectivity test (DNS resolution, port reachability) is performed first, ruling out obvious network issues before the formal connection attempt.

**Tool discovery and name mapping.** After a successful connection, the tool discovery function retrieves all tools provided by the Server via `tools/list`. Each tool is converted to a name with an `mcp__` prefix. The naming rule ensures all illegal characters (non-alphanumeric, non-underscore, non-hyphen) are replaced with underscores, and the prefix prevents name collisions with built-in tools.

The significance of name mapping goes beyond simple namespacing. Consider two MCP Servers that both provide a tool named `search` -- without the prefix they would collide. The three-segment naming `mcp__{serverName}__{toolName}` encodes both source and function simultaneously. The original tool name is preserved in the `originalToolName` field for use during invocation -- the Server receives the original name, not the mapped name.

There is also an easily overlooked detail in the connection process: headersHelper support. Remote Server configurations can specify an external program to dynamically generate request headers -- this program is executed, and its stdout is parsed as JSON for headers. The use case is authentication tokens that need frequent refreshing: rather than hardcoding an expiring token in configuration, you specify a script that dynamically obtains one on each connection. This "external program generates credentials" pattern is common in cloud-native environments (analogous to AWS's credential_process).


## 18.5 The Authentication Challenge: OAuth and XAA Dual-Track

The MCP authentication module exceeds 800 lines, implementing a complete OAuth 2.0 client. Authentication is complex because it must solve two fundamentally different scenarios.

**Scenario one: Individual developers (standard OAuth).** The standard OAuth 2.0 authorization code flow: discover the Server's OAuth metadata (RFC 9728 / RFC 8414), generate a PKCE challenge, start a local HTTP server to receive callbacks, open a browser for authorization, exchange the authorization code for an access token. Tokens are stored in the system's secure storage (macOS Keychain / Linux keyring), with keys based on a hash of the Server name and configuration, ensuring that identically named but differently configured Servers do not share credentials.

**Scenario two: Enterprise environments (XAA).** If every Server pops up a browser authorization, operations staff would go crazy. XAA (Cross-App Access) solves this: the user only needs to log in once at the enterprise IdP (Identity Provider), then uses RFC 8693 Token Exchange to convert the id_token into access_tokens for each MCP Server. Code comments clearly describe this flow: a single IdP browser login is shared across all XAA-enabled Servers.

The configuration model for XAA differs from standard OAuth in one crucial way. Standard OAuth's clientId and callbackPort are configured per Server -- because each Server has its own authentication server. XAA's configuration sits in the global IdP settings -- issuer, clientId, callbackPort are configured once (in the settings' `xaaIdp` field), shared by all XAA Servers. At the Server level, only a `xaa: true` boolean flag is needed to declare XAA support.

```pseudocode
// Standard OAuth: each Server configured independently
server_a: { oauth: { clientId: "xxx", callbackPort: 8080 } }
server_b: { oauth: { clientId: "yyy", callbackPort: 8081 } }

// XAA: global IdP + Server declaration
settings.xaaIdp: { issuer: "https://idp.company.com", clientId: "zzz" }
server_a: { oauth: { xaa: true } }
server_b: { oauth: { xaa: true } }
```

The fallback strategy on authentication failure is equally important. The system detects the "known to require authentication but no token available" state -- in this case the system does not futilely attempt to connect (which would inevitably return 401), but directly marks it as `needs-auth`, guiding the user to the `/mcp` command to complete authentication. XAA Servers are special, however: even without a stored token, a cached id_token may automatically complete authentication, so the connection attempt is not skipped.

An engineering highlight is the OAuth error normalization handler. Certain OAuth servers (such as Slack) return HTTP 200 for all responses, placing errors in the JSON body. Standard SDKs only parse errors when `!response.ok`, causing errors with 200 status codes to be treated as format errors. The normalization function intercepts responses and, upon detecting an OAuth error in the body, actively rewrites the status code to 400. Slack also uses non-standard error codes (`invalid_refresh_token` instead of `invalid_grant`), and the code maintains a set of non-standard error code aliases to normalize them. This is the reality of protocol implementations -- the specification is one thing, and each vendor's implementation is another.

Refresh token failure reasons are categorized into six types, each sent to the analytics system. OAuth flow errors are categorized into eight types. This fine-grained error classification enables the development team to pinpoint authentication issues precisely -- is the Server's metadata unreachable, did the token exchange fail, or did the user cancel authorization? Different causes require different remediation strategies.


## 18.6 Seven-Layer Configuration: Merging Strategy from Enterprise to Local

The MCP configuration module manages seven configuration scopes: `local`, `user`, `project`, `dynamic`, `enterprise`, `webapp`, and `managed`. Each layer corresponds to a real-world need.

**enterprise** represents IT department mandatory policies. **managed** represents constraints from hosted platforms. **user** is personal preferences (`~/.agent/settings.json`). **project** is team-shared project configuration (`.mcp.json`). **local** is personal overrides not committed to git (`.agent/settings.local.json`). **dynamic** is configuration dynamically added via API at runtime. **webapp** is connectors synchronized from the web interface.

Merge priority is determined by `Object.assign` parameter order: plugin is lowest, user next, project higher, local highest -- the closer the configuration is to the user, the higher its priority.

But enterprise is special. When enterprise MCP configuration exists, **all other sources are directly ignored**. This is not "enterprise has the highest priority" (which would mean other layers still exist but are overridden); it is "enterprise has exclusive control" -- enterprise administrators can ensure that users cannot add any MCP Servers on their own. This is a security policy, not a technical preference. Distinguishing between "highest priority" and "exclusive control" is critical in security model design -- the former allows users to add on top of enterprise policy; the latter prohibits it entirely.

Project-level configuration has its own trust model. A project's `.mcp.json` may be committed by team members, and the MCP Servers defined therein require explicit user approval before connection. Configuration files support upward directory tree traversal, with files closer to cwd taking higher priority -- consistent with `.gitignore` rules.

Configuration file writing is not a simple overwrite either. The write function first saves the existing file's permission bits, writes to a temporary file then performs a `datasync` (ensuring data is flushed to disk), then does an atomic `rename` -- if the rename fails, the temporary file is cleaned up. This "write-flush-rename" pattern prevents data corruption during power failures.

Project configuration (`.mcp.json`) has an additional security layer: directory tree traversal. The system searches upward from the current working directory to the repository root, collecting all `.mcp.json` files along the way. Files closer to cwd take higher priority. This means subdirectories can override parent directory MCP configurations -- a monorepo's frontend subproject can define its own MCP Server list without affecting the backend subproject. This traversal behavior is consistent with the discovery rules for `.gitignore`, `.eslintrc`, and similar files, making it a familiar pattern for developers.

The `managed` layer originates from remote management settings -- typically from MDM (Mobile Device Management) or enterprise configuration systems. These settings are fetched via specific API endpoints, loaded once at process startup, and do not change during the session. The distinction between managed and enterprise is: enterprise means "exclusive control" (if present, all others are ignored), while managed means "participates in merging" (merged together with other layers). Enterprise IT can choose which strategy to use: the former is more secure but more rigid; the latter is more flexible but requires careful management of merge semantics.


## 18.7 Deduplication: The Same Server Arriving from Multiple Channels

An underestimated complexity is that the same MCP Server may appear simultaneously from multiple channels. The user manually configured Slack in `.mcp.json`, an installed Plugin also introduces Slack, and the web interface syncs over yet another Slack connector. If all three configurations take effect, the model sees three duplicate sets of Slack tools, wasting the context window and causing confusion.

The deduplication function uses content signatures. The signature rule: for stdio types, the serialized string of the command serves as the signature; for remote types, the unwrapped original URL serves as the signature. Note the URL unwrapping logic -- in remote sessions, web connector URLs are rewritten by the proxy, but the original URL is preserved in query parameters. Deduplication must unwrap the proxy URL to compare correctly.

Why not deduplicate by name? Because different channels may use different names for the same Server (the user calls it "my-slack," the Plugin calls it "slack-connector"). Why not deduplicate solely by content? Because different Servers might coincidentally have the same URL but provide different tool sets (proxy server scenarios). Content signatures are the balance between the two.

Manually configured Servers always take priority over those introduced by Plugins. When a duplicate is detected, the Plugin's Server is suppressed and recorded in an error list for UI display -- not silently discarded, but explicitly communicated to the user. Plugin origin is tracked through the `pluginSource` field -- this field is tagged at configuration build time, avoiding the race condition of querying Plugin state (which might not yet be loaded) during deduplication.


## 18.8 Disconnection and Reconnection: Not as Simple as "Retry"

The reconnection strategy constants: up to 5 retries, initial backoff of 1 second, maximum backoff of 30 seconds.

But the truly interesting part is the error detection logic. The code lists 9 signals deemed "terminal connection errors": ECONNRESET, ETIMEDOUT, EPIPE, EHOSTUNREACH, ECONNREFUSED, Body Timeout Error, terminated, SSE stream disconnected, and Failed to reconnect SSE stream.

The system does not reconnect at the first sign of error -- it maintains a consecutive error counter. Only when 3 consecutive terminal errors occur does it proactively close the connection and trigger reconnection. Non-terminal errors reset the counter. This "N consecutive occurrences before declaring disconnection" strategy filters out transient network jitter, avoiding overly sensitive reconnection.

HTTP transport has a special disconnection scenario: session expiration. When an HTTP 404 combined with a JSON-RPC -32001 error code is detected, it means the server-side session has expired and requires reconnection with a fresh session ID.

When closing a connection, all memoize caches related to that connection are cleared: tool list, resource list, command list, and connection status. This guarantees fresh data after reconnection. Comments explain why the code does not call `client.onclose?.()` directly but instead goes through `client.close()` -- the former only clears caches, while the latter also rejects all pending request Promises. If tool calls are waiting, simply clearing the cache would leave them hanging indefinitely.

There is also a reentrancy guard: a "close already triggered" flag prevents the abort signal during the `close()` process from triggering another onerror -> close chain. Graceful shutdown in distributed systems is never truly graceful -- every shutdown path can trigger new errors, requiring explicit guards.

A notable timing detail in reconnection: the tool list must be re-fetched after reconnection. The MCP Server may have updated its tool definitions during the disconnection -- adding new tools or modifying parameter schemas. If reconnection continues using the cached old tool list, call parameters may not match the Server's latest definitions. This is why all memoize caches are cleared on connection close -- forcing fresh discovery after reconnection.

The backoff strategy design also merits analysis. Initial backoff of 1 second, maximum backoff of 30 seconds, doubling each time. The backoff sequence across five retries is 1s -> 2s -> 4s -> 8s -> 16s (capped at 30s), with total wait time of approximately 31 seconds. If the Server recovers within 30 seconds (such as a deployment restart), the system can reconnect automatically without user intervention. If it still has not recovered after 30 seconds, it is marked as failed and waits for the user to manually reconnect via `/mcp`. This time window represents a balance between "automatic recovery" and "user notification."


## 18.9 Security Policy: Allowlist, Denylist, and Three-Dimensional Matching

The MCP configuration module implements enterprise-grade access control. The core logic of the policy check is: the denylist takes absolute priority (regardless of what the allowlist says); an empty allowlist means deny all (`allowedMcpServers: []` is not "no restrictions" but "nothing allowed"); and the same Server can be matched through three dimensions: name, command (stdio), or URL (remote, with wildcard support).

URL wildcard matching is implemented by a regex conversion function -- `https://*.example.com/*` matches all services under that domain.

A subtle detail: when the "only allow managed servers" flag is true, the allowlist is read exclusively from managed policies, with user settings not participating -- but the denylist is always merged from all sources, because users can always deny Servers for themselves. This embodies a security design principle: "allow" is a restricted power, while "deny" is an inalienable right.

```pseudocode
function checkMcpServerAllowed(name, config, settings):
    // Step 1: denylist takes absolute priority
    if matchesDenylist(name, config, settings.deniedMcpServers):
        return DENIED

    // Step 2: empty allowlist = deny all
    if settings.allowedMcpServers is empty array:
        return DENIED

    // Step 3: three-dimensional matching
    if settings.allowedMcpServers is null:
        return ALLOWED  // no restrictions
    return matchesAllowlist(name, config, settings.allowedMcpServers)

    // Matching supports: exact name, exact command, URL wildcard
```


## 18.10 Connection Concurrency: The Science of Batch Size

The MCP client module defines two connection batch sizes: 3 concurrent connections for local Servers, 20 for remote Servers. Why such a large difference?

Local Server startup involves spawning subprocesses -- process creation is a heavy operation involving fork, exec, and runtime loading -- launching too many simultaneously would monopolize CPU and memory. Remote Servers involve only HTTP connections, constrained by I/O rather than CPU, and high concurrency actually reduces total wait time (network latency is parallel, not sequential).

Both numbers can be overridden via environment variables, allowing resource-constrained environments to further reduce concurrency, and resource-rich environments to increase it.

The number implies an underlying expectation: the system was designed with the assumption that users will connect to a large number of Servers simultaneously. MCP is not an "integration" solution for connecting one or two services -- it is platform infrastructure supporting the Agent ecosystem.

An easily overlooked detail: within a connection batch, ordered iteration rather than `Promise.all` is used -- connections within a batch are still launched in parallel, but batches execute sequentially. This avoids the system overload of forking dozens of subprocesses at once while maximizing parallelism within each batch.


## 18.11 MCP in Sub-Agents: Additive Connection

MCP does not only work in the main session -- sub-Agents can also declare their own MCP dependencies. The MCP initialization function in the Agent execution engine implements "additive" connection management: a sub-Agent's MCP Servers are added on top of the parent's existing connections, not as replacements.

The additive design has two key details. **Reference vs. inline:** MCP definitions in Agent frontmatter can be string references (such as `"github"`, reusing the parent's existing connection) or inline definitions (a complete Server configuration object, creating a new connection). String references are resolved through a configuration lookup function, then use a memoized connection function -- meaning multiple Agents referencing the same Server name share a single physical connection. Inline definitions create a new connection each time.

**Selective cleanup:** When a sub-Agent completes, only newly created connections (from inline definitions) are cleaned up. Shared connections from references are managed by the parent -- if a sub-Agent closed a connection the parent is actively using, subsequent MCP calls from the parent would fail. The code maintains two lists: `agentClients` (all connections, for tool discovery) and `newlyCreatedClients` (only newly created connections, for cleanup).

On the security policy front, when the `pluginOnly` policy is in effect, Agents from non-administrator trust sources cannot load custom MCP -- but Agents sourced from plugin, built-in, and policySettings are unrestricted. Comments explain the rationale for this distinction: a plugin Agent's MCP configuration is part of the administrator-approved Agent definition, and blocking it would break the plugin Agent's functionality.


## 18.12 Connection Observability

MCP connection state is not hidden from users -- the entire set of connection states is exposed through the `/mcp` command. The serialized state includes: names and connection types of all clients, all configurations (tagged by source scope), all discovered tools (including the original name mapping), and all resources.

The `SerializedTool` structure's `isMcp` flag identifies whether a tool comes from MCP -- in the tool list UI, MCP tools and built-in tools are displayed with different styles. The `originalToolName` field preserves the pre-mapping original name, letting users understand that `mcp__github__create_pr` corresponds to the GitHub Server's `create_pr` tool.

From an architectural perspective, MCP plays the role of a "capability extension platform" in this system. Built-in tools define the Agent's baseline capabilities (reading and writing files, executing commands), while MCP tools define extended capabilities (external service integrations). The seven-layer configuration ensures control at every level from individual to enterprise, the five connection states ensure precise user feedback, and the OAuth + XAA dual-track authentication ensures secure credential management. This is not merely a tool for "connecting external services" -- it is a complete capability governance framework.

MCP's design philosophy can be summarized with an analogy: it is the Agent system's "USB bus." USB defines a unified physical interface and communication protocol, allowing various peripherals (mice, keyboards, storage, cameras) to be plug-and-play. MCP defines a unified message protocol (JSON-RPC) and capability description format (Tools/Resources/Prompts), allowing various external services to be connect-and-use. USB's success lies not in being better than every dedicated interface (PS/2 mice have lower latency, FireWire transfers faster), but in the ecosystem effects that come from unification. MCP works the same way -- it may not be more efficient than each service's native SDK, but a unified interface lets the Agent use any protocol-compliant service interchangeably.

Looking back at the entire MCP subsystem, what is most impressive is not any single technical decision, but the **coordination of various "imperfections."** The transport layer has six options (because no single one covers all scenarios). Authentication has two approaches (because individual and enterprise needs are fundamentally different). Configuration has seven layers (because different stakeholders need different granularity of control). The error normalization function must handle Slack's non-standard behavior. The deduplication logic must handle proxy URL unwrapping. Each "imperfection" is a pragmatic response to real-world complexity. A "perfect" design -- one transport, one authentication method, one configuration layer -- can only exist on a whiteboard.

---

**Discussion Questions**

1. MCP chose JSON-RPC as its message format rather than gRPC or a custom binary protocol. What might the reasoning be? Hint: consider the developer profile of MCP Server implementers.

2. Why does enterprise configuration use "exclusive control" rather than "highest priority"? What is the essential difference between these two strategies in the security model? If an enterprise wants to allow users to add their own Servers on top of the managed list, how should this be designed?

3. The authentication error normalization function handles Slack's non-standard behavior. What reality of protocol implementation does this reflect? If you were designing a new protocol, how would you reduce this type of problem?

4. Deduplication uses content signatures rather than name matching. What problems would arise if deduplication were done only by name? What about only by content? Is designing a perfect deduplication strategy even possible?

5. The reconnection strategy of "3 consecutive terminal errors before reconnecting" -- are there scenarios it misses, such as alternating terminal and non-terminal errors that keep resetting the counter while the Server is actually unavailable? How would you improve this?

---

[← Back to Contents](../README.md)
