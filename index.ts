/**
 * /commit — commit the working tree without waiting for the agent to settle.
 *
 * Stages everything (unless `staged` is passed), generates one message from the staged
 * diff plus the session transcript, commits immediately, and reports the result back
 * into the session so the working agent knows the tree is clean.
 *
 * Usage: /commit [staged] [amend] [dir]   — all optional, any order.
 *   staged  commit only what is already staged
 *   amend   rewrite the last commit instead of adding one; the message describes the whole
 *           amended commit (diffed against its parent), and an empty index means message-only
 *   dir     repository to commit, default the session cwd
 *
 * Config, both under <cwd>/.pi/ (never the target repo's):
 *   git-commit.json           { "model": "<inherit|provider/modelId>", "thinking": "low" }
 *   commit-message-format.md  the message shape, honoured only when the project is trusted
 *
 * Pure logic lives in ./lib.ts; this file is the pi wiring and the git side effects.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildPrompt,
	buildReport,
	buildSystemPrompt,
	type Config,
	clipText,
	diffBase,
	expandDir,
	gitFailure,
	LIMITS,
	normalizeConfig,
	parseArgs,
	sanitizeMessage,
	summarizeToolArguments,
	invalidMessage,
} from "./lib.ts";

function loadConfig(ctx: ExtensionCommandContext): Config {
	const path = join(ctx.cwd, CONFIG_DIR_NAME, "git-commit.json");

	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = undefined;
	}

	const { config, warning } = normalizeConfig(raw);
	if (warning) ctx.ui.notify(`${path}: ${warning}`, "warning");
	return config;
}

function loadMessageFormat(ctx: ExtensionCommandContext): string {
	if (!ctx.isProjectTrusted()) return "";
	try {
		return readFileSync(join(ctx.cwd, CONFIG_DIR_NAME, "commit-message-format.md"), "utf8").trim();
	} catch {
		return "";
	}
}

async function resolveRepoRoot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	dir: string | undefined,
): Promise<string | undefined> {
	const base = dir ? expandDir(ctx.cwd, dir) : ctx.cwd;

	try {
		if (!statSync(base).isDirectory()) {
			ctx.ui.notify(`not a directory: ${base}`, "warning");
			return undefined;
		}
	} catch {
		ctx.ui.notify(`no such directory: ${base}`, "warning");
		return undefined;
	}

	let result;
	try {
		result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: base, timeout: 15_000 });
	} catch (error) {
		ctx.ui.notify(`git unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}

	if (result.code !== 0 || !result.stdout.trim()) {
		ctx.ui.notify(`not a git repository: ${base}`, "warning");
		return undefined;
	}
	return result.stdout.trim();
}

function messageBlock(entry: SessionEntry): { role: string; text: string } | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const content = message.content;
	if (typeof content === "string") {
		const text = content.trim();
		return text ? { role: message.role, text } : undefined;
	}

	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
		else if (part.type === "toolCall") parts.push(`→ ${part.name}(${summarizeToolArguments(part.arguments)})`);
	}
	const text = parts.join("\n").trim();
	return text ? { role: message.role, text } : undefined;
}

/**
 * Newest-first walk over the branch, so a tool-heavy turn cannot empty the window the way
 * slicing before filtering does. Tool results and thinking stay out: the diff is the source
 * of truth for what changed, and logs or redacted reasoning invite themselves into the body.
 */
function sessionTranscript(ctx: ExtensionCommandContext): string {
	const branch = ctx.sessionManager.getBranch();

	let summary = "";
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction" && entry.summary.trim()) {
			summary = `[earlier session summary]\n${clipText(entry.summary.trim(), LIMITS.compactionSummary)}`;
			break;
		}
	}

	const blocks: string[] = summary ? [summary] : [];
	let total = summary.length;

	for (let i = branch.length - 1; i >= 0 && total < LIMITS.transcriptTotal; i--) {
		const block = messageBlock(branch[i]);
		if (!block) continue;

		const rendered = `[${block.role}] ${clipText(block.text, LIMITS.transcriptEntry)}`;
		blocks.push(rendered);
		total += rendered.length;
	}

	return blocks.reverse().join("\n\n");
}

function pickModel(ctx: ExtensionCommandContext, config: Config): Model<Api> | undefined {
	const name = config.model;
	if (!name || name === "inherit") return ctx.model ?? undefined;

	const slash = name.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
		if (found) return found;
	}
	return ctx.modelRegistry.getAll().find((model) => model.id === name || `${model.provider}/${model.id}` === name);
}

async function generateMessage(
	ctx: ExtensionCommandContext,
	model: Model<Api>,
	config: Config,
	systemPrompt: string,
	prompt: string,
): Promise<string | undefined> {
	let response;
	try {
		response = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{ reasoning: config.thinking, signal: ctx.signal },
			)
			.result();
	} catch (error) {
		ctx.ui.notify(`commit message model failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		ctx.ui.notify(`commit message model failed: ${response.errorMessage ?? response.stopReason}`, "error");
		return undefined;
	}

	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	return text || undefined;
}

async function runCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
	const parsed = parseArgs(rawArgs);
	if ("error" in parsed) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}

	const config = loadConfig(ctx);
	const root = await resolveRepoRoot(pi, ctx, parsed.dir);
	if (!root) return;

	const parent = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD^"], { cwd: root, timeout: 15_000 });
	const hasParent = parent.code === 0 && parent.stdout.trim().length > 0;

	// Only a root commit needs it, and only the repository knows its object format (sha1 vs sha256).
	let emptyTree = "";
	if (parsed.amend && !hasParent) {
		const hash = await pi.exec("git", ["hash-object", "-t", "tree", "/dev/null"], { cwd: root, timeout: 15_000 });
		emptyTree = hash.stdout.trim();
		if (!emptyTree) {
			ctx.ui.notify("cannot resolve the empty tree of this repository", "error");
			return;
		}
	}

	const base = diffBase(parsed.amend, hasParent, emptyTree);
	const baseArgs = base ? [base] : [];
	const statArgs = ["diff", "--cached", "--stat", ...baseArgs];
	const diffArgs = ["diff", "--cached", ...baseArgs];

	if (!parsed.staged) {
		const added = await pi.exec("git", ["add", "-A"], { cwd: root, timeout: 120_000 });
		if (added.code !== 0) {
			ctx.ui.notify(`git add failed: ${gitFailure(added.stderr, added.stdout, added.code)}`, "error");
			return;
		}
	}

	const stat = await pi.exec("git", statArgs, { cwd: root, timeout: 120_000 });
	if (stat.code !== 0) {
		ctx.ui.notify(`git diff failed: ${gitFailure(stat.stderr, stat.stdout, stat.code)}`, "error");
		return;
	}

	const diff = await pi.exec("git", diffArgs, { cwd: root, timeout: 120_000 });
	if (diff.code !== 0) {
		ctx.ui.notify(`git diff failed: ${gitFailure(diff.stderr, diff.stdout, diff.code)}`, "error");
		return;
	}
	if (!diff.stdout.trim()) {
		const what = parsed.amend ? "nothing to amend" : parsed.staged ? "nothing staged" : "nothing to commit";
		ctx.ui.notify(`${what} in ${root}`, "warning");
		return;
	}

	const model = pickModel(ctx, config);
	if (!model) {
		ctx.ui.notify(
			config.model && config.model !== "inherit"
				? `unknown model "${config.model}" — check ${CONFIG_DIR_NAME}/git-commit.json`
				: "no model available to write the message",
			"error",
		);
		return;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		ctx.ui.notify(`no credentials configured for ${model.provider}`, "error");
		return;
	}

	const prompt = buildPrompt(stat.stdout, diff.stdout, sessionTranscript(ctx));
	const generated = await generateMessage(ctx, model, config, buildSystemPrompt(loadMessageFormat(ctx)), prompt);
	if (!generated) return;

	const message = sanitizeMessage(generated);
	const problem = invalidMessage(message);
	if (problem) {
		ctx.ui.notify(`commit message rejected (${problem}); ${root} left staged`, "error");
		return;
	}

	const commitArgs = parsed.amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
	const committed = await pi.exec("git", commitArgs, { cwd: root, timeout: 120_000 });
	if (committed.code !== 0) {
		ctx.ui.notify(`git commit failed: ${gitFailure(committed.stderr, committed.stdout, committed.code)}`, "error");
		return;
	}

	const head = await pi.exec("git", ["log", "-1", "--format=%h %s"], { cwd: root, timeout: 15_000 });
	const summary = await pi.exec("git", ["show", "--stat", "--oneline", "HEAD"], { cwd: root, timeout: 30_000 });
	const headLine = head.stdout.trim() || "(commit created)";
	const where = root === ctx.cwd ? "" : ` in ${root}`;

	const verb = parsed.amend ? "amended" : "committed";
	ctx.ui.notify(`${verb} ${headLine}${where}`, "info");

	pi.sendMessage(
		{
			customType: "git-commit",
			content: buildReport(headLine, summary.stdout.trim(), where, parsed.amend),
			display: true,
		},
		{ deliverAs: "steer", triggerTurn: false },
	);
}

export default function gitCommit(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Commit the tree, message generated from the staged diff and session transcript",
		handler: async (args, ctx) => {
			await runCommit(pi, ctx, args);
		},
	});
}
