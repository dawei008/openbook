# Chapter 20: Commands and the Plugin System

> How do 80+ commands go from a pile of imports to a discoverable, extensible, and controllable interaction system?

```
     ┌──────────────────────────────┐
     │         User Input           │
     │            │                 │
     │      / (slash prefix)        │
     │            │                 │
     │ ★ Command System ★          │  ◄── Focus of this chapter
     │ ┌──────────────────────────┐ │
     │ │ Builtin │ Skill │ Plugin │ │
     │ │  local  │prompt │  MCP   │ │
     │ │local-jsx│      │ hooks  │ │
     │ └─────┬────┬──────┬───────┘ │
     │       │    │      │         │
     │   execute inject connect    │
     │       ▼    ▼      ▼         │
     │   [Result/Prompt/Service]   │
     └──────────────────────────────┘
```

## 20.1 The Problem: The Entry Point for User Interaction

The previous two chapters covered how the Agent connects to the external world (MCP) and installs domain expertise (Skills). But how does the user trigger all of this?

Type `/` in the Agent system, and you see dozens of available commands. `/commit` generates commit messages, `/review` reviews code, `/mcp` manages external service connections. These commands are the "front door" for user-Agent interaction -- compared to describing intent in natural language, commands provide precise, discoverable operation entry points.

But this is not just a "command registry" problem. Over 80 commands come from five different sources (built-in, Skill, Plugin, workflow, MCP), some are visible only to certain users, some are disabled in remote mode, and some require runtime conditions to be enabled. How do you organize these commands so that users experience a seamless whole, while allowing developers to extend them along multiple dimensions?

## 20.2 Three Command Types: Different Execution Models

The command type definition module defines the type system for commands. Three types correspond to three entirely different execution methods.

**Prompt commands.** Type `'prompt'`. When invoked, they return a text segment injected into the conversation, letting the model handle subsequent operations. Skills are this type. The core method is the prompt retrieval function -- it performs no operations itself, only provides instructions. After receiving the instructions, the model independently decides how to complete the task.

This is the most interesting type: the command itself does nothing; it merely passes the "what to do" knowledge to the model. `/review` is not a review program -- it is a prompt that tells the model how to do a review.

**Local commands.** Type `'local'`. These execute locally without going through the model. `/clear` clears the screen, `/cost` displays costs. They load their implementation modules through lazy loading:

```pseudocode
type LocalCommand = {
    type: 'local'
    supportsNonInteractive: boolean
    load: () => Promise<CommandModule>
}
```

`load` returns a Promise -- the command module is only imported when actually invoked. This is a performance optimization: if all 80+ commands were loaded at startup, it would slow down launch.

**Local-JSX commands.** Type `'local-jsx'`. These render interactive UI (based on Ink/React). `/mcp` displays the Server management interface, `/skills` lists available skills. They differ from local commands in requiring the Ink runtime, which is unavailable in some environments (such as the remote bridge).

## 20.3 Command Registration: A Memoized Large Array

The command aggregation module begins with a long series of imports -- over 80 command modules. All commands are aggregated through a memoized function:

```pseudocode
ALL_COMMANDS = memoize((): Command[] => [
    addDir, advisor, agents, branch, btw, chrome, clear, ...
    ...(bridgeEnabled ? [bridgeCmd] : []),
    ...(voiceEnabled ? [voiceCmd] : []),
    ...(isInternalUser && !isDemo ? INTERNAL_COMMANDS : []),
])
```

Three design decisions deserve attention:

**memoize.** The array is constructed only once. Since construction involves feature flag checks and conditional expansion, memoize avoids redundant computation.

**Conditional expansion.** `...(feature ? [cmd] : [])` controls command visibility at both compile time and runtime. When a flag is off, the corresponding `require()` call is removed at compile time by dead code elimination -- not only is it not loaded at runtime, the code itself does not appear in the build output.

**Why a function instead of a constant.** The underlying function needs to read configuration, which is not available during module initialization. Wrapping it in a function defers execution until the first call.

## 20.4 Feature-Gated Commands: Compile-Time Pruning

The command aggregation module showcases feature flag-controlled commands:

```pseudocode
proactiveCmd = FEATURE('PROACTIVE') || FEATURE('KAIROS')
    ? require('./commands/proactive') : null
bridgeCmd = FEATURE('BRIDGE_MODE')
    ? require('./commands/bridge/index') : null
voiceCmd = FEATURE('VOICE_MODE')
    ? require('./commands/voice/index') : null
```

`FEATURE()` is a compile-time constant. This is not a runtime check -- when the flag is false, the entire `require()` call is removed by the bundler's dead code elimination. The final build artifact contains none of this command's code.

There is also a set of internal-only commands:

```pseudocode
INTERNAL_COMMANDS = [
    backfillSessions, breakCache, bughunter, commit, commitPushPr, ...
]
```

These are loaded only in internal employee environments. Unlike feature flags, this is a runtime check, because user type is an environment variable.

## 20.5 Command Aggregation: Five-Way Parallel Loading

The core function for loading all commands is the entry point for retrieving all available commands:

```pseudocode
loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
    [
        { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
        pluginCommands,
        workflowCommands,
    ] = await Promise.all([
        getSkills(cwd),
        getPluginCommands(),
        getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
    ])

    return [
        ...bundledSkills,         // 1. Bundled Skills
        ...builtinPluginSkills,   // 2. Built-in Plugin Skills
        ...skillDirCommands,      // 3. Directory-loaded Skills
        ...workflowCommands,      // 4. Workflow commands
        ...pluginCommands,        // 5. Plugin commands
        ...pluginSkills,          // 6. Plugin Skills
        ...ALL_COMMANDS(),        // 7. Built-in commands (last)
    ]
})
```

The concatenation order implies priority: built-in commands go last. This means if a user defines a Skill with the same name as a built-in command, the user's Skill takes precedence -- user intent overrides system defaults.

The error handling strategy for Skills loading is worth noting: each loading path is wrapped in `.catch()`, returning an empty array and logging on failure rather than crashing the entire command system. This is a textbook example of defensive programming -- Skill loading is a non-critical path, and a problematic Skill should not block the normal use of `/help` or `/clear`.

## 20.6 Availability Filtering: Dynamic Command Visibility

The command retrieval function adds two layers of filtering on top of loading:

```pseudocode
baseCommands = allCommands.filter(
    cmd => meetsAvailability(cmd) && isEnabled(cmd),
)
```

**The availability check function** filters commands based on the user's authentication status:

```pseudocode
function meetsAvailability(cmd: Command): boolean {
    if !cmd.availability: return true
    for a in cmd.availability:
        switch a:
            case 'web-app':
                if isSubscriber(): return true; break
            case 'console':
                if !isSubscriber() && !isThirdParty() && isFirstPartyUrl():
                    return true; break
    return false
}
```

Certain commands are visible only to web subscribers; others only to API console users. Note that this function **is not memoized** -- comments explicitly state: authentication status may change during a session (the user ran `/login`), so each call must re-evaluate.

**Dynamic Skill insertion.** Runtime-discovered Skills are inserted before built-in commands but after other extension commands:

```pseudocode
insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))
return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
]
```

This positioning ensures dynamic Skills do not override built-in commands, but appear before them in the completion list.

## 20.7 Security Boundaries: Remote Mode and Bridge Mode

Different runtime environments permit different commands. The code defines explicit security boundaries.

**Remote-safe command set** -- the set of commands available in `--remote` mode:

```pseudocode
REMOTE_SAFE: Set<Command> = new Set([
    session, exit, clear, help, theme, color, vim, cost, usage, copy, ...
])
```

Only commands that do not depend on the local filesystem, git, shell, IDE, or MCP can be used in remote mode. This is not a feature limitation but a security design -- in remote mode, commands execute on the remote end, where local resources are unreachable.

**Bridge-safe command set** -- the subset of commands available through remote bridging (mobile/web clients):

```pseudocode
BRIDGE_SAFE: Set<Command> = new Set([
    compact, clear, cost, summary, releaseNotes, files,
])
```

The bridge safety check function's logic reveals the relationship between type and security:

```pseudocode
function isBridgeSafe(cmd: Command): boolean {
    if cmd.type === 'local-jsx': return false    // No Ink UI rendering
    if cmd.type === 'prompt': return true         // All Skills are allowed
    return BRIDGE_SAFE.has(cmd)                   // Local commands need explicit whitelisting
}
```

local-jsx commands require terminal rendering capability, which is unavailable on mobile, so they are universally prohibited. Prompt commands are merely text expansions with no UI involvement, so they are all allowed. Only local commands require individual security review.

## 20.8 Plugin System: The Heaviest Extension Unit

Plugins are the most heavyweight unit in the system's extension architecture. A single Plugin can simultaneously provide Commands, Skills, Hooks, and MCP Servers -- four capabilities bundled together.

The built-in Plugin management module shows the core Plugin structure:

```pseudocode
plugin: LoadedPlugin = {
    name,
    manifest: { name, description, version },
    path: BUILTIN_MARKETPLACE,
    source: pluginId,          // format: "name@marketplace"
    repository: pluginId,
    enabled: isEnabled,
    isBuiltin: true,
    hooksConfig: definition.hooks,
    mcpServers: definition.mcpServers,
}
```

Plugin enable/disable follows a three-layer evaluation:

1. `isAvailable()` -- Runtime environment detection. Some Plugins are only available on specific operating systems
2. User settings -- The user's explicit preference
3. Default state -- The Plugin's declared default

First check whether it can be used, then whether the user wants to use it, and finally the default value. This order ensures that environment limitations cannot be overridden by the user, while user preferences can override defaults.

Skills provided by Plugins are aggregated through a collector function -- only Skills from enabled Plugins are loaded. When converting a Plugin Skill to a standard Command, the source is set to `'bundled'` rather than `'builtin'`. Comments explain this counterintuitive choice:

```pseudocode
// 'bundled' not 'builtin' -- 'builtin' in Command.source means hardcoded
// slash commands (/help, /clear). Using 'bundled' keeps these skills in
// the Skill tool's listing, analytics name logging, and prompt-truncation
// exemption.
```

`'builtin'` has special meaning (hardcoded system commands). Using `'bundled'` keeps Plugin Skills in the skill listing, analytics logs, and prompt truncation exemption. The naming is confusing, but the semantics are precise.

## 20.9 Cache Strategy: Two-Level Clearing

The command system employs multi-layer memoize caching. The command aggregation module defines two levels of cache clearing:

```pseudocode
function clearMemoizationCaches():
    loadAllCommands.cache?.clear()
    getSkillToolList.cache?.clear()
    getSlashCommandSkills.cache?.clear()
    clearSkillIndex?.()

function clearAllCaches():
    clearMemoizationCaches()
    clearPluginCommandCache()
    clearPluginSkillsCache()
    clearSkillDirectoryCaches()
```

**Lightweight clearing**: Clears only the aggregation layer's caches, leaving underlying data sources intact. Used during dynamic Skill discovery -- when a new Skill is found, the aggregation layer needs to know there is new data, but does not need to rescan all directories.

**Full clearing**: Clears all cache levels, including Skill file caches and Plugin caches. Used for configuration changes or explicit refresh.

Note that the Skill index clearing function is conditionally imported via feature flag -- if experimental Skill search is not enabled, this clearing function does not exist. This is another example of compile-time pruning.

## 20.10 Command Lookup: Name, Canonical Name, and Aliases

The command lookup function's matching logic involves three types of matching:

```pseudocode
function findCommand(commandName: string, commands: Command[]): Command | undefined {
    return commands.find(cmd =>
        cmd.name === commandName ||
        getCanonicalName(cmd) === commandName ||
        cmd.aliases?.includes(commandName),
    )
}
```

`name` is the internal identifier, the canonical name function returns the user-visible canonical name (which may be formatted), and `aliases` is the alias list. `.find()` returns the first match -- since the loading order places Skills before built-in commands, a Skill with the same name will "shadow" a built-in command. This is an intentional priority design.

## 20.11 The Synergy of Three Extension Mechanisms

Commands + Skills + MCP are not three independent systems, but three extension dimensions of different complexity. Let us understand their synergy from the perspective of user behavior.

**Dimension one: Commands -- the user interaction layer.** The user types `/review`, the system finds the corresponding prompt command, calls the prompt retrieval function, and injects it into the conversation. If it is a local command like `/clear`, it executes directly. If it is a local-jsx command like `/mcp`, it renders an interactive UI.

**Dimension two: Skills -- the model capability layer.** During work, the model discovers it needs specific knowledge (such as security review rules) and invokes the corresponding Skill through SkillTool. The Skill's content is injected into the conversation, and the model reads it then acts on its own. Conditional Skills automatically activate when the model encounters matching files.

**Dimension three: MCP -- the service integration layer.** The model needs to create a GitHub PR and calls `mcp__github__create_pull_request`. The request is sent to the GitHub Server via the MCP protocol, the Server makes the API call, and the result returns to the model.

The three converge through the unified `Command` type. Skills are special Commands (type `'prompt'`), MCP tools are independent Tools (though MCP Prompts also become Commands). The loading sequence is:

```
Startup
  |-- Register built-in Skills
  |-- Register built-in Plugins
  |-- Connect MCP Servers

Runtime
  |-- Retrieve all commands
  |     |-- Load Skills (directory, Plugin, Bundled)
  |     |-- Load Plugin commands
  |     |-- Load built-in commands
  |     |-- Load dynamically discovered Skills

During file operations
  |-- Discover new Skill directories
  |-- Activate conditional Skills
```

Namespace isolation prevents collisions: built-in commands use short names (`help`, `clear`), MCP tools use the `mcp__` prefix (`mcp__github__create_issue`), and Skills use directory names (`security-review`). Plugin commands can use any name, but if they conflict with existing commands, first-registered wins.

The key insight of this three-layer architecture is: **each layer solves a different problem.**

- Need a precise user interaction entry point? Use a Command
- Need reusable domain knowledge? Use a Skill
- Need external service integration? Use MCP
- Need all of the above? Bundle them in a Plugin

And the barrier to entry is progressive: from writing a Markdown file (Skill), to configuring a JSON file (MCP), to developing a complete plugin package (Plugin). Users can choose the appropriate complexity level for their needs.

---

**Discussion Questions**

1. Command loading places built-in commands last in the concatenation order, allowing user Skills to shadow built-in commands. What risks does this design pose? If a malicious project-level Skill names itself `help` or `clear`, what would happen?

2. The availability check function is not memoized, re-evaluating on every call. What problems would arise if it were memoized? Conversely, how significant is the performance cost of re-evaluating every time?

3. In the bridge safety policy, prompt commands are universally allowed while local-jsx commands are universally prohibited. If a prompt Skill contains malicious instructions (such as "delete all files"), is this policy sufficiently secure? Where should the security boundary be?

4. The Plugin system's built-in plugin initialization is currently empty (comments say it is scaffolding). What might motivate migration from bundled Skills to built-in Plugins? What is the fundamental difference between the two in terms of controllability?

---

[← Back to Contents](../README.md)
