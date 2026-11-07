import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildPrompt,
	buildReport,
	buildSystemPrompt,
	clipDiff,
	clipStat,
	clipText,
	DEFAULT_MESSAGE_FORMAT,
	diffBase,
	expandDir,
	FORMAT_PLACEHOLDER,
	invalidMessage,
	LIMITS,
	normalizeConfig,
	parseArgs,
	sanitizeMessage,
	SYSTEM_PROMPT_TEMPLATE,
	summarizeToolArguments,
} from "./lib.ts";

describe("parseArgs", () => {
	test("no arguments", () => {
		expect(parseArgs("")).toEqual({ staged: false, amend: false });
		expect(parseArgs("   ")).toEqual({ staged: false, amend: false });
	});

	test("staged alone", () => {
		expect(parseArgs("staged")).toEqual({ staged: true, amend: false });
	});

	test("amend alone", () => {
		expect(parseArgs("amend")).toEqual({ staged: false, amend: true });
	});

	test("dir alone", () => {
		expect(parseArgs("~/code/repo")).toEqual({ staged: false, amend: false, dir: "~/code/repo" });
	});

	test("both flags, either order, with a dir", () => {
		expect(parseArgs("staged amend ~/code/repo")).toEqual({ staged: true, amend: true, dir: "~/code/repo" });
		expect(parseArgs("amend ~/code/repo staged")).toEqual({ staged: true, amend: true, dir: "~/code/repo" });
		 expect(parseArgs("~/code/repo amend")).toEqual({ staged: false, amend: true, dir: "~/code/repo" });
	});

	test("quoted dir keeps its spaces", () => {
		expect(parseArgs('staged "/tmp/my repo"')).toEqual({ staged: true, amend: false, dir: "/tmp/my repo" });
		expect(parseArgs("'/tmp/my repo'")).toEqual({ staged: false, amend: false, dir: "/tmp/my repo" });
	});

	test("repeated keywords are harmless", () => {
		expect(parseArgs("staged staged")).toEqual({ staged: true, amend: false });
		expect(parseArgs("amend amend")).toEqual({ staged: false, amend: true });
	});

	test("two leftover tokens is a usage error", () => {
		const parsed = parseArgs("staged amend foo bar");
		expect("error" in parsed).toBe(true);
		if ("error" in parsed) expect(parsed.error).toContain("usage: /commit [staged] [amend] [dir]");
	});

	test("keywords are matched exactly, not as prefixes", () => {
		expect(parseArgs("stagedness")).toEqual({ staged: false, amend: false, dir: "stagedness" });
		expect(parseArgs("amended")).toEqual({ staged: false, amend: false, dir: "amended" });
		expect(parseArgs("STAGED")).toEqual({ staged: false, amend: false, dir: "STAGED" });
	});
});

describe("diffBase", () => {
	const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

	test("a normal commit diffs the index against HEAD", () => {
		expect(diffBase(false, true, emptyTree)).toBeUndefined();
		expect(diffBase(false, false, emptyTree)).toBeUndefined();
	});

	test("an amend diffs against the amended commit's parent", () => {
		expect(diffBase(true, true, emptyTree)).toBe("HEAD^");
	});

	test("an amended root commit diffs against whatever empty tree git reported", () => {
		expect(diffBase(true, false, emptyTree)).toBe(emptyTree);
		expect(diffBase(true, false, "different-hash-for-sha256-repos")).toBe("different-hash-for-sha256-repos");
	});
});

describe("clipping", () => {
	test("clipText marks a cut only when it cuts", () => {
		expect(clipText("short", 10)).toBe("short");
		expect(clipText("0123456789abc", 10)).toBe("0123456789\n… [truncated]");
	});

	test("clipDiff keeps small files and truncates a large one", () => {
		const small = "diff --git a/one b/one\n+x\ndiff --git a/two b/two\n+y";
		expect(clipDiff(small)).toBe(small);

		const big = `diff --git a/big b/big\n+${"z".repeat(LIMITS.diffPerFile * 2)}`;
		const clipped = clipDiff(big);
		expect(clipped).toContain("… [truncated]");
		expect(clipped.length).toBeLessThan(big.length);
	});

	test("clipDiff drops files past the total budget and says how many", () => {
		const file = (n: number) => `diff --git a/f${n} b/f${n}\n+${"z".repeat(LIMITS.diffPerFile - 20)}`;
		const diff = Array.from({ length: 10 }, (_, i) => file(i)).join("\n");

		const clipped = clipDiff(diff);
		expect(clipped).toContain("more file(s) not shown");
		expect(clipped.length).toBeLessThan(LIMITS.diffTotal + 100);
	});

	test("clipStat caps lines and reports the remainder", () => {
		const stat = Array.from({ length: LIMITS.statLines + 5 }, (_, i) => ` file${i} | 1 +`).join("\n");
		const clipped = clipStat(stat);
		expect(clipped).toContain("… [5 more line(s)]");
		expect(clipped.split("\n")).toHaveLength(LIMITS.statLines + 1);
	});
});

describe("summarizeToolArguments", () => {
	test("prefers command over path", () => {
		expect(summarizeToolArguments({ path: "a.ts", command: "git status -s" })).toBe("git status -s");
	});

	test("falls back to the key list", () => {
		expect(summarizeToolArguments({ weird: 1, other: 2 })).toBe("weird, other");
	});

	test("clips a long command to one line", () => {
		const summary = summarizeToolArguments({ command: `git log\n${"x".repeat(200)}` });
		expect(summary.endsWith("…")).toBe(true);
		expect(summary.length).toBe(LIMITS.toolArgument + 1);
		expect(summary).not.toContain("\n");
	});

	test("empty arguments", () => {
		expect(summarizeToolArguments(undefined)).toBe("");
		expect(summarizeToolArguments({})).toBe("");
	});
});

describe("sanitizeMessage", () => {
	test("strips a wrapping code fence", () => {
		expect(sanitizeMessage("```\nfeat: add x\n\n- y\n```")).toBe("feat: add x\n\n- y");
	});

	test("strips a verbatim git commit line", () => {
		expect(sanitizeMessage('git commit -m "feat: add x"')).toBe("feat: add x");
		expect(sanitizeMessage("git commit -m 'fix: y'")).toBe("fix: y");
	});

	test("strips a leading label", () => {
		expect(sanitizeMessage("Commit message: fix: y")).toBe("fix: y");
		expect(sanitizeMessage("message: fix: y")).toBe("fix: y");
	});

	test("strips surrounding quotes", () => {
		expect(sanitizeMessage('"fix: y"')).toBe("fix: y");
	});

	test("collapses blank runs and trims line ends", () => {
		expect(sanitizeMessage("feat: x\n\n\n\n- y   ")).toBe("feat: x\n\n- y");
	});

	test("leaves an ordinary message alone", () => {
		const message = "fix(commit): keep staged paths after a failed commit\n\n- leave the index untouched on failure";
		expect(sanitizeMessage(message)).toBe(message);
	});
});

describe("invalidMessage", () => {
	test("rejects empty and whitespace", () => {
		expect(invalidMessage("")).toBe("empty message");
	});

	test("rejects an over-long subject", () => {
		expect(invalidMessage("x".repeat(LIMITS.subject + 1))).toContain("limit is 100");
	});

	test("rejects an echoed diff", () => {
		expect(invalidMessage("feat: x\n\ndiff --git a/x b/x")).toBe("model echoed the diff");
		expect(invalidMessage("@@ -1 +1 @@")).toBe("model echoed the diff");
	});

	test("accepts a normal message", () => {
		expect(invalidMessage("feat: add /commit\n\n- stage, generate, commit")).toBeUndefined();
	});
});

describe("normalizeConfig", () => {
	test("missing file means defaults", () => {
		expect(normalizeConfig(undefined)).toEqual({ config: { thinking: "low" }, warning: undefined });
	});

	test("reads model and thinking", () => {
		expect(normalizeConfig('{"model":"deepseek/deepseek-flash","thinking":"HIGH"}')).toEqual({
			config: { model: "deepseek/deepseek-flash", thinking: "high" },
			warning: undefined,
		});
	});

	test("blank model is treated as inherit", () => {
		expect(normalizeConfig('{"model":"  "}').config.model).toBeUndefined();
	});

	test("unknown thinking level warns and falls back", () => {
		const { config, warning } = normalizeConfig('{"thinking":"loud"}');
		expect(config.thinking).toBe("low");
		expect(warning).toContain("unknown thinking level");
	});

	test("broken JSON warns and falls back", () => {
		const { config, warning } = normalizeConfig("{oops");
		expect(config).toEqual({ thinking: "low" });
		expect(warning).toContain("invalid JSON");
	});
});

describe("expandDir", () => {
	test("expands the home shorthand", () => {
		expect(expandDir("/work", "~")).toBe(homedir());
		expect(expandDir("/work", "~/code/repo")).toBe(join(homedir(), "code/repo"));
	});

	test("resolves everything else against cwd", () => {
		expect(expandDir("/work", "sub")).toBe(resolve("/work", "sub"));
		expect(expandDir("/work", "/abs")).toBe("/abs");
	});

	test("leaves another user's home alone rather than guessing", () => {
		expect(expandDir("/work", "~other/repo")).toBe(resolve("/work", "~other/repo"));
	});
});

describe("prompts", () => {
	test("transcript section is omitted when there is none", () => {
		const prompt = buildPrompt("f | 1 +", "diff --git a/f b/f\n+x", "");
		expect(prompt).toContain("## Staged diff (source of truth)");
		expect(prompt).not.toContain("## Session transcript");
	});

	test("transcript is labelled intent-only", () => {
		const prompt = buildPrompt("f | 1 +", "diff --git a/f b/f\n+x", "[user] add a thing");
		expect(prompt).toContain("## Session transcript (intent only; the diff is the source of truth)");
		expect(prompt).toContain("[user] add a thing");
	});

	test("the repository's format file is interpolated into the template", () => {
		const format = "Subject: name the change.\n\nBody: one bullet per change.";
		const prompt = buildSystemPrompt(format);
		expect(prompt).toBe(SYSTEM_PROMPT_TEMPLATE.replace(FORMAT_PLACEHOLDER, () => format));
		expect(prompt).toContain("Commit message format (follow it exactly):");
		expect(prompt).not.toContain(FORMAT_PLACEHOLDER);
	});

	test("a format file containing $ patterns survives interpolation", () => {
		const format = "Cost is $& and $' and $1, literally.";
		expect(buildSystemPrompt(format)).toContain(format);
	});

	test("with no format file the built-in template is used", () => {
		const prompt = buildSystemPrompt("");
		expect(prompt).toBe(SYSTEM_PROMPT_TEMPLATE.replace(FORMAT_PLACEHOLDER, () => DEFAULT_MESSAGE_FORMAT));
		expect(prompt).toContain("The shape is a ceiling");
	});

});

describe("buildReport", () => {
	test("carries hash, stat and the do-not-recommit line", () => {
		const report = buildReport("abc1234 feat: x", "abc1234 feat: x\n f | 1 +", " in /repo", false);
		expect(report).toContain("/commit committed in /repo: abc1234 feat: x");
		expect(report).toContain("f | 1 +");
		expect(report).toContain("do not commit those changes again");
	});

	test("says amended when the commit was rewritten", () => {
		const report = buildReport("abc1234 feat: x", "", "", true);
		expect(report).toContain("/commit amended: abc1234 feat: x");
		expect(report).toContain("now amended");
	});

	test("drops an empty stat section", () => {
		expect(buildReport("abc1234 feat: x", "", "", false).split("\n\n")).toHaveLength(2);
	});
});
