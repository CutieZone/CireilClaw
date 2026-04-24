import type { BlockRule, Condition, PathRule } from "#config/schemas/conditions.js";
import type { Session } from "#harness/session.js";

/**
 * Evaluate a single condition against the session context.
 */
function evaluate(condition: Condition, session: Session): boolean {
  if (condition === "tui") {
    return session.channel === "tui";
  }
  if (condition === "internal") {
    return session.channel === "internal";
  }

  if (condition.startsWith("discord:")) {
    // All discord conditions require a discord session
    if (session.channel !== "discord") {
      return false;
    }

    const parts = condition.split(":");
    const [, part1, part2, ..._rest] = parts;

    if (part1 === "nsfw") {
      return session.isNsfw;
    }

    if (part1 === "dm") {
      // DM means no guildId
      if (session.guildId !== undefined) {
        return false;
      }

      // discord:dm matches any DM
      if (parts.length === 2) {
        return true;
      }

      // discord:dm:<channelId> matches specific DM channel
      if (parts.length === 3 && part2 !== undefined) {
        return session.channelId === part2;
      }
    }

    if (part1 === "guild" && parts.length === 3 && part2 !== undefined) {
      // discord:guild:<guildId>
      return session.guildId === part2;
    }

    if (part1 === "channel" && parts.length === 3 && part2 !== undefined) {
      // discord:channel:<channelId>
      return session.channelId === part2;
    }
  }

  return false;
}

/**
 * Evaluate a rule's conditions against the session context.
 */
function evaluateRule(
  rule: { when: Condition | readonly Condition[]; mode?: "and" | "or" },
  session: Session,
): boolean {
  const conditions: readonly Condition[] = Array.isArray(rule.when) ? rule.when : [rule.when];
  const mode = rule.mode ?? "or";

  if (conditions.length === 1) {
    // oxlint-disable-next-line typescript-eslint/prefer-destructuring
    const cond = conditions[0];
    if (cond !== undefined) {
      return evaluate(cond, session);
    }
  }

  return mode === "and"
    ? conditions.every((cond) => evaluate(cond, session))
    : conditions.some((cond) => evaluate(cond, session));
}

/**
 * Check which conditional blocks should be loaded for this session.
 * Returns an array of block names that match the conditions.
 */
function getMatchingBlockNames(
  blocks: Record<string, BlockRule> | undefined,
  session: Session,
): string[] {
  if (blocks === undefined) {
    return [];
  }

  const matching: string[] = [];
  for (const [name, rule] of Object.entries(blocks)) {
    if (evaluateRule(rule, session)) {
      matching.push(name);
    }
  }
  return matching;
}

/**
 * Check if a path should be accessible given the conditional rules.
 *
 * Evaluation order:
 * 1. Check for deny rules that match - if any match conditions, deny access
 * 2. Check for allow rules that match - if any match conditions, allow access
 * 3. If no rules match the path, default allow (baseline sandbox handles this)
 *
 * @param sandboxPath The area-relative sandbox path (e.g., "/nsfw/secret.md" within memories)
 * @param rules Record of path patterns to rules
 * @param session The current session
 * @returns true if access is allowed, false if denied
 */
function checkPathAccess(
  sandboxPath: string,
  rules: Record<string, PathRule> | undefined,
  session: Session,
): boolean {
  if (rules === undefined) {
    return true; // No rules means default allow
  }

  // Find all rules that match this path (prefix or exact match)
  const matchingRules: { path: string; rule: PathRule }[] = [];

  for (const [rulePath, rule] of Object.entries(rules)) {
    // Normalize rule path - ensure it starts with /
    const normalizedRulePath = rulePath.startsWith("/") ? rulePath : `/${rulePath}`;

    // Check if the sandbox path matches this rule
    // Rules ending with / match as prefix, others match exactly
    if (normalizedRulePath.endsWith("/")) {
      // Prefix match: /nsfw/ matches /nsfw/ and /nsfw/anything.md
      if (
        sandboxPath.startsWith(normalizedRulePath) ||
        sandboxPath === normalizedRulePath.slice(0, -1)
      ) {
        matchingRules.push({ path: normalizedRulePath, rule });
      }
    } else if (sandboxPath === normalizedRulePath) {
      // Exact match
      matchingRules.push({ path: normalizedRulePath, rule });
    }
  }

  if (matchingRules.length === 0) {
    return true; // No matching rules = default allow
  }

  // Evaluate deny rules first - any matching deny blocks access
  for (const { rule } of matchingRules) {
    if (rule.action === "deny" && evaluateRule(rule, session)) {
      return false;
    }
  }

  // Then evaluate allow rules - any matching allow grants access
  for (const { rule } of matchingRules) {
    if (rule.action === "allow" && evaluateRule(rule, session)) {
      return true;
    }
  }

  // Rules exist for this path but none matched the conditions
  // Default to deny for paths with rules
  return false;
}

export { checkPathAccess, evaluate, evaluateRule, getMatchingBlockNames };
