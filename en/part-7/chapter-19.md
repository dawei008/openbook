# Chapter 19: Skills -- User-Defined Capabilities

> What if every developer could teach an Agent new abilities without writing a single line of code?

```
     ┌──────────────────────────┐
     │      Agent Loop          │
     │   ┌─────┐                │
     │   │ LLM │                │
     │   └──┬──┘                │
     │      │                   │
     │  SkillTool               │
     │      │                   │
     │ ★ Skills System ★       │  ◄── Focus of this chapter
     │ ┌────────────────────┐   │
     │ │ .agent/skills/     │   │
     │ │  SKILL.md + assets │   │
     │ │ Conditional paths  │   │
     │ │ Dynamic discovery  │   │
     │ └────────────────────┘   │
     │      │                   │
     │  prompt injection        │
     │  into conversation       │
     └──────────────────────────┘
```

## 19.1 The Problem: The Barrier to Knowledge Sharing

The previous chapter showed how MCP connects the Agent to external services. But there is a category of "capability" that does not require external services -- it is a combination of knowledge, workflows, and judgment criteria.

Consider an example: your team has a set of security rules for code reviews. Each time a review is needed, you want the Agent to check for SQL injection, XSS, privilege leaks, and so on. You have three ways to achieve this:

**Approach one**: Manually remind it every time in conversation. "Please review this code according to our security rules, including checking for SQL injection..." This is tedious and prone to omissions.

**Approach two**: Write it into AGENT.md. This works, but the security rules would appear in every conversation's system prompt -- including when you are not doing a review. This wastes context window and increases noise.

**Approach three**: Package it as a Skill. It is invoked only during reviews, without polluting other conversations. The model knows it exists (the name and description are always visible), but the full content is only loaded when needed.

The design philosophy behind Skills is: **encapsulate reusable Agent behaviors as on-demand units**. If MCP is about "connecting external services," Skills is about "installing domain expertise." And the barrier to participation is extremely low -- all you need to write is Markdown.

## 19.2 The Physical Form of a Skill: One Directory, One File

What does a Skill look like on the filesystem?

```
.agent/skills/
  security-review/
    SKILL.md          <- Core file
    checklist.sh      <- Optional helper script
```

Why must it be the `skill-name/SKILL.md` directory format, rather than allowing standalone `.md` files? The Skills directory loader explicitly processes only directories:

```pseudocode
// Directory scanning logic
if entry is not a directory and not a symbolic link:
    return null  // Standalone .md files are skipped
```

This decision seems redundant (wouldn't a single file suffice?), but it ensures each Skill has its own namespace. Helper scripts, data files, and configuration templates can all be placed in the Skill directory and referenced via the built-in Skill directory variable. If standalone files were allowed, Skills would lose the ability to carry resources.

SKILL.md consists of two parts: YAML frontmatter and a Markdown body. The frontmatter defines the Skill's "metadata contract." The frontmatter parser handles all supported fields, several of which deserve special attention:

- **when_to_use** -- Tells the model when to automatically invoke this Skill. This is the key to the Skill being proactively discovered by the model
- **disable-model-invocation** -- When set to true, the model cannot invoke it autonomously; only the user can trigger it manually via `/skill-name`. Suitable for high-risk operations that require human judgment before activation
- **context: 'fork'** -- Executes in a sub-Agent with an independent context and token budget. Prevents large Skills from exhausting the main session's context window
- **paths** -- Glob pattern matching; the Skill activates only when operating on files that match the pattern. Detailed in Section 19.6
- **effort** -- Controls the depth of thinking the model devotes when executing the Skill

## 19.3 Multi-Source Parallel Loading: Five-Way Race

Where do Skills come from? The Skill directory command retrieval function defines three levels of sources:

```pseudocode
managedDir  = join(getManagedPath(), '.agent', 'skills')   // Enterprise policy
globalDir   = join(getConfigHome(), 'skills')                // User global
projectDirs = traverseUpToHome('skills', workingDir)         // Project-level (multiple)
```

Add the extra directories specified by `--add-dir` and the legacy `/commands/` directory, and there are five data sources in total. They load in parallel via `Promise.all`:

```pseudocode
[managedResults, globalResults, projectResultsNested, extraResultsNested, legacyResults]
  = await Promise.all([...])
```

Five paths in parallel, with no interdependencies. Each is an independent directory scan and file read. This means a slow enterprise NFS will not block the loading of local Skills.

But parallel loading introduces a problem: the same Skill may be discovered through different paths -- for instance via symlinks, or when `--add-dir` overlaps with a project directory. The system detects duplicates by resolving symlinks with `realpath`:

```pseudocode
async function resolveFileIdentity(path: string): Promise<string | null> {
    return await realpath(path)
}
```

All file identity computations are also performed in parallel, then deduplicated in a synchronous loop using a first-wins strategy. Comments specifically mention why `realpath` is used instead of inodes: certain virtual/container/NFS filesystems report unreliable inode values (such as inode 0). This is a pitfall discovered in real user environments.

There is also a lean mode branch: it skips all automatic discovery and loads only paths explicitly specified by `--add-dir`. This is designed for embedded scenarios -- when the Agent is integrated into a CI/CD pipeline, you do not want it automatically discovering and executing Skills from the project.

## 19.4 How a Skill Becomes a Command

Every Skill is ultimately converted into a `Command` object. The Skill command builder function is the core of this transformation. The generated Command's type is fixed as `'prompt'` -- a Skill is fundamentally a prompt, not an executable program.

The most critical method in the Command is the function that retrieves the prompt content. When a Skill is invoked, this function determines what gets injected into the conversation. Rather than simply returning the raw Markdown, it goes through a series of processing steps:

**Step one: Base directory prefix.** If the Skill has a baseDir, `Base directory for this skill: /path/to/skill` is prepended to the content. This tells the model where the Skill's resource files are located.

**Step two: Parameter substitution.** `${1}` positional parameters and `${ARG_NAME}` named parameters are replaced with actual values.

**Step three: Built-in variable substitution.** The Skill directory path variable is replaced with the Skill's directory path (on Windows, backslashes are also converted to forward slashes). The session ID variable is replaced with the current session ID -- allowing Skills to generate session-unique logs or reports.

**Step four: Shell command execution.** This is the most interesting step. Special code blocks in the Markdown (those marked with `!`) are actually executed, with their output replacing the content. This means a Skill can dynamically gather information at load time -- for example, a review Skill that runs `git diff` at load time to capture current changes.

But there is a critical security check:

```pseudocode
if source is not 'mcp':
    content = await executeEmbeddedShellCommands(...)
```

MCP-sourced Skills are remote and untrusted -- **they must never execute shell commands locally**. This is an inviolable security boundary.

## 19.5 Built-in Skills: Domain Expertise Compiled into the Binary

In addition to user-defined Skills, the system ships with a set of built-in Skills managed through a registration pattern.

The built-in Skill registration function features an elegant lazy-loading design. If a Skill includes companion files, these files are extracted to disk only on first invocation. The key detail is that the extraction promise is memoized:

```pseudocode
let pending: Promise<string | null> | undefined
onInvoke = async (args, ctx) => {
    pending ??= extractBundledFiles(skillName, fileList)
    ...
}
```

The `??=` assignment means multiple concurrent invocations trigger only a single extraction. If the first and second invocations happen nearly simultaneously, they await the same promise. This prevents file write races.

File extraction is also security-hardened:

```pseudocode
SAFE_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
```

`O_EXCL` ensures only new files are created (no overwriting of existing files), and `O_NOFOLLOW` prevents symlink attacks. Comments describe the defense model: the extraction directory name includes a per-process random nonce, which is the primary defense; these flags serve as defense in depth.

The path safety validation function also checks for path traversal: the canonicalized path must not be absolute and must not contain `..`. This prevents a malicious built-in Skill definition from writing outside the Skill directory.

## 19.6 Conditional Activation: Skills Triggered by File Paths

This is one of the most elegant features of the Skills system. Through the frontmatter's `paths` field, a Skill can declare that it only cares about specific files:

```yaml
---
description: "React component best practices"
paths: ["src/components/**", "*.tsx"]
---
```

This Skill is not immediately visible to the model when loaded. It is placed in a conditional Skill waiting list. When the model operates on a file, the conditional activation function checks whether the file path matches:

```pseudocode
matcher = createGlobMatcher(skill.paths)
if matcher.matches(relativePath):
    activeSkills.set(name, skill)       // Move to active list
    pendingSkills.delete(name)          // Remove from waiting list
    activatedNames.add(name)            // Record as activated
```

Matching uses the same syntax as `.gitignore`. Once activated, there is no rollback: the activated names set is a session-persistent Set. Even if the cache is cleared and rebuilt, an activated Skill will not be placed back on the waiting list.

Why does this feature matter? Imagine a large monorepo where frontend, backend, and infrastructure each have different best practices. Exposing all Skills to the model simultaneously wastes tokens and increases noise. Conditional activation lets Skills stand guard: when you touch `*.tsx` files, the React Skill automatically activates; when you touch `terraform/*.tf`, the IaC Skill automatically activates.

## 19.7 Dynamic Discovery: Finding New Skills at Runtime

Conditional activation handles "known but not yet activated" Skills. There is another scenario: the Agent discovers a previously unknown Skill directory while operating on files.

The dynamic discovery function traverses upward from the file path to cwd, checking the `.agent/skills/` directory at each level:

```pseudocode
while currentDir starts with (resolvedCwd + separator):
    skillDir = join(currentDir, '.agent', 'skills')
    if skillDir not in checkedDirs:
        checkedDirs.add(skillDir)
        // Check if directory exists, if it's gitignored...
```

Several design decisions are worth noting:

**Only directories below cwd are discovered.** cwd-level Skills are already loaded at startup; this handles only Skills nested in subdirectories.

**The checked directories set is a Set**, recording all paths checked -- whether successful or not. This avoids redundant `stat` calls on nonexistent directories. In large projects, if every file operation triggers a directory scan, repeated stats on nonexistent paths become a performance bottleneck.

**gitignore filtering.** After discovering a Skill directory, the system also checks whether its parent directory is gitignored. This prevents `node_modules/some-pkg/.agent/skills/` from being accidentally loaded -- a real and dangerous attack vector.

**Sorted by depth.** Results are ordered with the deepest directories first, ensuring Skills closer to the file have higher priority.

## 19.8 Token Economics: Resident Cost vs. On-Demand Loading

The impact of Skills on the context window is carefully managed. The frontmatter token estimation function only counts the resident portion's tokens:

```pseudocode
function estimateFrontmatterTokens(skill: Command): number {
    text = [skill.name, skill.description, skill.whenToUse]
        .filter(Boolean)
        .join(' ')
    return roughTokenEstimate(text)
}
```

The name, description, and when_to_use are always resident -- the model needs to know which Skills are available. But the full Markdown content is only injected upon invocation. This is a classic lazy-loading strategy: directory cost is low (a few dozen tokens), full loading cost is high (potentially thousands of tokens), and the full cost is incurred only when confirmed necessary.

The tool list filter function in the command aggregation module further controls which Skills appear in the model's tool list:

```pseudocode
allCommands.filter(cmd =>
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&
    cmd.source !== 'builtin' &&
    (cmd.loadedFrom === 'bundled' ||
     cmd.loadedFrom === 'skills' ||
     cmd.loadedFrom === 'commands_DEPRECATED' ||
     cmd.hasDescription ||
     cmd.whenToUse),
)
```

Skills without a description or when_to_use do not appear on the model's radar -- they can only be triggered manually via the `/` command. This is a signal-to-noise ratio optimization.

## 19.9 The Complementary Relationship Between Skills and MCP

The capability domains of Skills and MCP appear to overlap, but they are actually complementary. The key distinction lies in execution:

MCP tool execution happens on the Server side -- the model sends a call request, the Server executes the logic, and returns the result. Skill execution happens on the model side -- Skill content is injected into the conversation, and the model reads the instructions then acts on its own. One is a "remote procedure call"; the other is "handing an expert an operations manual."

The Skill source type definition reveals the intersection point between the two:

```pseudocode
type SkillSource =
    | 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
```

`'mcp'` means an MCP Server can expose Skills via `prompts/list` -- this is remote Skill distribution. But MCP-sourced Skills have strict security restrictions: embedded shell commands are not permitted to execute.

The bridging layer is implemented through dependency inversion:

```pseudocode
registerMCPSkillBridge({
    buildSkillCommand,
    parseFrontmatter,
})
```

This is classic dependency inversion. The Skills module does not import the MCP module (which would create a circular dependency); instead it registers its own builder functions in a leaf module for the MCP module to consume. Comments explain why dynamic import is not used: in Bun-bundled binaries, dynamic imports with variable paths cannot be resolved at runtime.

The design philosophy behind this complementary relationship is to lower the barrier to participation. Writing an MCP Server requires programming skills; writing a Skill requires only Markdown. The former suits tool and API developers; the latter suits anyone with domain knowledge -- technical writers, operations engineers, security auditors. Together they form the Agent's capability ecosystem.

---

**Discussion Questions**

1. Why does a conditional Skill never deactivate once activated? If "deactivation" were allowed, what additional complexities would the system need to handle?

2. MCP-sourced Skills are prohibited from executing embedded shell commands. If this restriction were removed, what attack surface would it open?

3. The frontmatter token estimation function only estimates the resident portion's tokens. If a project defines 100 Skills, each averaging 50 tokens of frontmatter, the total resident cost is 5,000 tokens. Is this cost acceptable? Is there room for further optimization?

4. The Skill "directory format" requirement (no standalone files) is a design trade-off. It increases the friction of creating a Skill but provides the ability to carry resources. Do you consider this trade-off reasonable? If both formats were supported simultaneously, what complexities would that introduce?

---

[← Back to Contents](../README.md)
