import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
// Config errors print one line per issue — `<path>: <fix-it message>` — in
// the repo's plain error style; z.prettifyError's ✖/→ decorations clash
// with it, so the issues are formatted here instead (same content).
function formatPath(path) {
    let out = "";
    for (const key of path) {
        const segment = typeof key === "number" ? `[${key}]` : String(key);
        out += typeof key === "number" || out === "" ? segment : `.${segment}`;
    }
    return out;
}
export function formatConfigError(error) {
    const lines = error.issues.map((issue) => {
        const path = formatPath(issue.path);
        return path === "" ? issue.message : `${path}: ${issue.message}`;
    });
    return ["error: local-ci.yml is invalid", ...lines].join("\n");
}
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NameSchema = z
    .string({ error: "name must be a string, e.g. name: unit" })
    .refine((name) => NAME_PATTERN.test(name) && !name.includes(".."), {
    error: (issue) => `"${String(issue.input)}" is not a valid Check name; use letters, numbers, ., _, or -, and never ".."`,
});
const CommandSchema = z
    .string({ error: "has no command; add one, e.g. command: pnpm test" })
    .trim()
    .min(1, { error: "has no command; add one, e.g. command: pnpm test" });
const TIMEOUT_MESSAGE = "timeout must be a positive finite number of seconds, e.g. timeout: 60";
const TimeoutSchema = z
    .number({ error: TIMEOUT_MESSAGE })
    .refine((value) => Number.isFinite(value) && value > 0, {
    error: TIMEOUT_MESSAGE,
});
const DependsOnSchema = z.array(z.string({
    error: "each depends_on entry must be a Check name, e.g. depends_on: [build]",
}), {
    error: "depends_on must be a list of Check names, e.g. depends_on: [build]",
});
const RunIfChangedSchema = z
    .array(z
    .string({ error: "each run_if_changed entry must be a non-empty glob" })
    .min(1, {
    error: "each run_if_changed entry must be a non-empty glob",
}), { error: "run_if_changed must be a non-empty list of globs" })
    .min(1, { error: "run_if_changed must contain at least one glob" });
const COPY_MESSAGE = "copy must be a folder path relative to the repository root, e.g. copy: packages/app";
// A repository-relative folder, normalized to POSIX form without a leading
// "./" or trailing "/". "." copies the whole tree. Absolute paths and ".."
// segments are rejected: the copy comes from `git archive <sha>:<path>`,
// which only reaches inside the tree.
const CopySchema = z
    .string({ error: COPY_MESSAGE })
    .trim()
    .min(1, { error: COPY_MESSAGE })
    .refine((path) => !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes(".."), { error: COPY_MESSAGE })
    .transform((path) => {
    const segments = path
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".");
    return segments.length ? segments.join("/") : ".";
});
function unknownField(issue, valid) {
    const names = (issue.keys ?? []).map((key) => `"${String(key)}"`).join(", ");
    return `unknown field ${names}; remove it, or use ${valid}`;
}
export const CheckSchema = z.strictObject({
    name: NameSchema,
    command: CommandSchema,
    timeout: TimeoutSchema.optional(),
    depends_on: DependsOnSchema.optional(),
    run_if_changed: RunIfChangedSchema.optional(),
    copy: CopySchema.optional(),
}, {
    error: (issue) => issue.code === "unrecognized_keys"
        ? unknownField(issue, "name, command, timeout, depends_on, run_if_changed, or copy")
        : "each Check must be a map of name and command, e.g. - name: unit with command: pnpm test",
});
// Whole-config rules, one .superRefine: unique names; every depends_on
// name exists and is not the Check itself; no cycles. Each issue carries a
// path pointing at the bad item and a fix-it message.
function validateGraph(config, ctx) {
    const indexByName = new Map();
    const seenNames = new Set();
    config.checks.forEach((check, i) => {
        if (seenNames.has(check.name)) {
            ctx.addIssue({
                code: "custom",
                path: ["checks", i, "name"],
                message: `Check "${check.name}" is listed twice; give every Check a unique name`,
            });
            return;
        }
        seenNames.add(check.name);
        indexByName.set(check.name, i);
    });
    config.checks.forEach((check, i) => {
        for (const [j, dep] of (check.depends_on ?? []).entries()) {
            if (dep === check.name) {
                ctx.addIssue({
                    code: "custom",
                    path: ["checks", i, "depends_on", j],
                    message: `depends_on names "${dep}", which is the Check itself; remove it from its own depends_on`,
                });
            }
            else if (!indexByName.has(dep)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["checks", i, "depends_on", j],
                    message: `depends_on names "${dep}", which is not a Check in this file; list a name from checks`,
                });
            }
        }
    });
    // Cycles: depth-first in list order; an edge back to a Check still on
    // the stack closes a loop, reported once with every name in it.
    const visitState = new Map();
    const stack = [];
    const visit = (name) => {
        visitState.set(name, "active");
        stack.push(name);
        const check = config.checks[indexByName.get(name) ?? -1];
        for (const dep of check?.depends_on ?? []) {
            if (dep === name || !indexByName.has(dep))
                continue; // reported above
            const state = visitState.get(dep);
            if (state === "active") {
                const cycle = [...stack.slice(stack.indexOf(dep)), dep];
                ctx.addIssue({
                    code: "custom",
                    path: ["checks", indexByName.get(dep) ?? 0],
                    message: `depends_on cycle ${cycle.join(" -> ")}; remove one depends_on entry to break it`,
                });
            }
            else if (state === undefined) {
                visit(dep);
            }
        }
        stack.pop();
        visitState.set(name, "done");
    };
    for (const check of config.checks)
        visit(check.name);
}
const ConfigInputSchema = z.strictObject({
    timeout: TimeoutSchema.default(60),
    checks: z
        .array(CheckSchema, {
        error: "checks must be a list; see usage.md for the list form",
    })
        .min(1, {
        error: "checks must list at least one Check; add one, e.g. name: unit with command: pnpm test",
    }),
}, {
    error: (issue) => issue.code === "unrecognized_keys"
        ? unknownField(issue, "timeout or checks")
        : "local-ci.yml must be a map of timeout and checks",
});
export const ConfigSchema = ConfigInputSchema.superRefine(validateGraph).transform((config) => ({
    checks: config.checks.map((check) => ({
        ...check,
        timeout: check.timeout ?? config.timeout,
        depends_on: check.depends_on ?? [],
    })),
}));
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function loadChecks() {
    let doc;
    try {
        doc = YAML.parse(await readFile("local-ci.yml", "utf8"));
    }
    catch {
        throw new Error("error: local-ci.yml: invalid YAML");
    }
    // v0.1.0 wrote checks as a map of name to command; that form is gone.
    if (isRecord(doc) && isRecord(doc.checks))
        throw new Error("error: local-ci.yml: checks must be a list; see usage.md for the list form");
    const parsed = ConfigSchema.safeParse(doc);
    if (!parsed.success)
        throw new Error(formatConfigError(parsed.error));
    return parsed.data;
}
