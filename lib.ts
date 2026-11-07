/**
 * Pure helpers behind /commit — argument parsing, prompt assembly, message validation.
 * Nothing here touches pi, the filesystem beyond `os.homedir()`, or the network, so
 * `lib.test.ts` runs under plain `bun test` without pi's module aliases.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_THINKING: ThinkingLevel = "low";

export const LIMITS = {
	diffPerFile: 4_000,
	diffTotal: 24_000,
	statLines: 60,
	transcriptEntry: 1_200,
	transcriptTotal: 6_000,
	compactionSummary: 1_500,
	toolArgument: 100,
	subject: 100,
};

export const FORMAT_PLACEHOLDER = "{{format}}";

export const SYSTEM_PROMPT_TEMPLATE = `You write exactly one git commit message for a staged diff.

The session transcript in the prompt is intent only; the diff is the source of truth. Never invent files, behavior, reasons, or symbols absent from the diff. If the transcript and diff disagree, describe the diff.

Commit message format (follow it exactly):

${FORMAT_PLACEHOLDER}

Output only the commit message: the subject line, then a blank line and the body when there is one. No code fence, no preamble, no sign-off, no attribution.`;

/** Fallback when the repository ships no format file: the shape this extension shipped with. */
export const DEFAULT_MESSAGE_FORMAT = `Subject: imperative, names the change, 72 characters or fewer, specific enough that \`git log --oneline\` alone identifies it.

Body: one bullet per change, one line each. A bullet carries what a reader needs — what the change makes true, or what breaks without it. No paragraph prose in the body.

The shape is a ceiling: a one-change commit needs only its subject, and a bullet that restates a line of the diff is noise. Do not pad a thin commit into a long one.`;

export function buildSystemPrompt(messageFormat: string): string {
	const format = messageFormat.trim() || DEFAULT_MESSAGE_FORMAT;
	// Function replacement: a literal one would expand `$&`, `$'` and friends found in the format file.
	return SYSTEM_PROMPT_TEMPLATE.replace(FORMAT_PLACEHOLDER, () => format);
}

/** Trim to a cap, marking the cut so the model knows it is looking at an excerpt. */
export function clipText(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n… [truncated]` : text;
}

export function oneLine(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

export interface ParsedArgs {
	staged: boolean;
	dir?: string;
}

export function parseArgs(raw: string): ParsedArgs | { error: string } {
	const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const words = tokens.map((token) => {
		const quoted = /^(["'])[\s\S]*\1$/.test(token) && token.length >= 2;
		return quoted ? token.slice(1, -1) : token;
	});

	let staged = false;
	const rest: string[] = [];
	for (const word of words) {
		if (word === "staged") {
			staged = true;
			continue;
		}
		rest.push(word);
	}

	if (rest.length === 0) return { staged };
	if (rest.length > 1) {
		return { error: `unrecognised arguments (${rest.join(" ")}) — usage: /commit [staged] [dir]` };
	}
	return { staged, dir: rest[0] };
}

export interface Config {
	model?: string;
	thinking: ThinkingLevel;
}

/** Parse the config file's text. IO stays in the caller; this only decides what it means. */
export function normalizeConfig(raw: string | undefined): { config: Config; warning?: string } {
	const fallback: Config = { thinking: DEFAULT_THINKING };
	if (raw === undefined) return { config: fallback };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { config: fallback, warning: "invalid JSON, using defaults" };
	}
	if (!parsed || typeof parsed !== "object") return { config: fallback };

	const record = parsed as Record<string, unknown>;
	const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;

	let thinking: ThinkingLevel = DEFAULT_THINKING;
	let warning: string | undefined;
	if (typeof record.thinking === "string" && record.thinking.trim()) {
		const candidate = record.thinking.trim().toLowerCase();
		if (THINKING_LEVELS.has(candidate)) thinking = candidate as ThinkingLevel;
		else warning = `unknown thinking level "${record.thinking}", using ${DEFAULT_THINKING}`;
	}

	return { config: { model, thinking }, warning };
}

export function expandDir(cwd: string, dir: string): string {
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
	return resolve(cwd, dir);
}

/** Split a unified diff into per-file chunks, keeping the `diff --git` header. */
export function splitDiff(diff: string): string[] {
	return diff.split(/\n(?=diff --git )/);
}

export function clipDiff(diff: string): string {
	const kept: string[] = [];
	let total = 0;
	let dropped = 0;

	for (const file of splitDiff(diff)) {
		const clipped = clipText(file, LIMITS.diffPerFile);
		if (total + clipped.length > LIMITS.diffTotal) {
			dropped++;
			continue;
		}
		kept.push(clipped);
		total += clipped.length + 1;
	}

	let out = kept.join("\n");
	if (dropped) out += `\n… [${dropped} more file(s) not shown]`;
	return out;
}

export function clipStat(stat: string): string {
	const lines = stat.trim().split("\n");
	if (lines.length <= LIMITS.statLines) return lines.join("\n");
	const rest = lines.length - LIMITS.statLines;
	return [...lines.slice(0, LIMITS.statLines), `… [${rest} more line(s)]`].join("\n");
}

const TOOL_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt", "title"];

export function summarizeToolArguments(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const key of TOOL_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return oneLine(value, LIMITS.toolArgument);
	}
	const keys = Object.keys(args);
	return keys.length ? keys.slice(0, 4).join(", ") : "";
}

export function buildPrompt(stat: string, diff: string, transcript: string): string {
	const parts = ["## Staged files", clipStat(stat), "", "## Staged diff (source of truth)", clipDiff(diff)];

	if (transcript.trim()) {
		parts.push("", "## Session transcript (intent only; the diff is the source of truth)", transcript);
	}

	return parts.join("\n");
}

export function sanitizeMessage(raw: string): string {
	let text = raw.trim();

	const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/.exec(text);
	if (fenced) text = fenced[1].trim();

	text = text.replace(/^git commit(?:\s+-[a-z]+)*\s+(["'])([\s\S]*)\1$/i, "$2").trim();
	text = text.replace(/^git commit\b[^\n]*\n+/i, "").trim();
	text = text.replace(/^(?:commit message|message)\s*:\s*/i, "").trim();

	const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
	if (quoted) text = quoted[2].trim();

	const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function invalidMessage(message: string): string | undefined {
	if (!message) return "empty message";
	const subject = message.split("\n", 1)[0].trim();
	if (!subject) return "empty subject";
	if (subject.length > LIMITS.subject) return `subject is ${subject.length} chars, limit is ${LIMITS.subject}`;
	if (/^(diff --git |index [0-9a-f]+\.\.|@@ )/m.test(message)) return "model echoed the diff";
	return undefined;
}

export function gitFailure(stderr: string, stdout: string, code: number): string {
	const text = (stderr || stdout).trim();
	return text ? `${text} (exit ${code})` : `git exited ${code}`;
}

/** What the agent reads back after a successful commit. */
export function buildReport(headLine: string, statText: string, where: string): string {
	return [
		`/commit committed${where}: ${headLine}`,
		statText,
		"Everything staged at that moment is now committed; do not commit those changes again.",
	]
		.filter(Boolean)
		.join("\n\n");
}
