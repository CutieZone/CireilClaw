import type { BlockRule, Condition, PathRule } from "#config/schemas/conditions.js";
import type { Session } from "#harness/session.js";

function evaluate(condition: Condition, session: Session): boolean {
  const negate = condition.startsWith("!");
  const base = negate ? condition.slice(1) : condition;

  let result = false;

  if (base === "tui") {
    result = session.channel === "tui";
  } else if (base === "internal") {
    result = session.channel === "internal";
  } else if (base.startsWith("discord:")) {
    // All discord conditions require a discord session
    if (session.channel === "discord") {
      const parts = base.split(":");
      const [, part1, part2, ..._rest] = parts;

      if (part1 === "nsfw") {
        result = session.isNsfw;
      } else if (part1 === "dm") {
        if (session.guildId !== undefined) {
          result = false;
        } else if (parts.length === 2) {
          result = true;
        } else if (parts.length === 3 && part2 !== undefined) {
          result = session.channelId === part2;
        } else {
          result = false;
        }
      } else if (part1 === "guild" && parts.length === 3 && part2 !== undefined) {
        result = session.guildId === part2;
      } else if (part1 === "channel" && parts.length === 3 && part2 !== undefined) {
        result = session.channelId === part2;
      } else {
        result = false;
      }
    } else {
      result = false;
    }
  } else {
    result = false;
  }

  return negate ? !result : result;
}

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

function checkPathAccess(
  sandboxPath: string,
  rules: Record<string, PathRule> | undefined,
  session: Session,
): boolean {
  if (rules === undefined) {
    return true;
  }

  const matchingRules: { path: string; rule: PathRule }[] = [];

  for (const [rulePath, rule] of Object.entries(rules)) {
    const normalizedRulePath = rulePath.startsWith("/") ? rulePath : `/${rulePath}`;

    if (normalizedRulePath.endsWith("/")) {
      if (
        sandboxPath.startsWith(normalizedRulePath) ||
        sandboxPath === normalizedRulePath.slice(0, -1)
      ) {
        matchingRules.push({ path: normalizedRulePath, rule });
      }
    } else if (sandboxPath === normalizedRulePath) {
      matchingRules.push({ path: normalizedRulePath, rule });
    }
  }

  if (matchingRules.length === 0) {
    return true;
  }

  for (const { rule } of matchingRules) {
    if (rule.action === "deny" && evaluateRule(rule, session)) {
      return false;
    }
  }

  for (const { rule } of matchingRules) {
    if (rule.action === "allow" && evaluateRule(rule, session)) {
      return true;
    }
  }

  return false;
}

export { checkPathAccess, evaluate, evaluateRule, getMatchingBlockNames };
