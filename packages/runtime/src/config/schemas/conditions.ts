import * as vb from "valibot";

const nonEmptyString = vb.pipe(vb.string(), vb.nonEmpty());

// Simple string condition schema with validation (supports optional `!` prefix for negation)
const ConditionStringSchema = vb.message(
  vb.pipe(
    vb.string(),
    vb.check((str) => {
      const base = str.startsWith("!") ? str.slice(1) : str;
      return (
        base === "discord:nsfw" ||
        base === "discord:dm" ||
        /^discord:dm:\d+$/.test(base) ||
        /^discord:guild:\d+$/.test(base) ||
        /^discord:channel:\d+$/.test(base) ||
        base === "tui" ||
        base === "internal"
      );
    }),
  ),
  "Invalid condition format. Supported: [!]discord:nsfw, [!]discord:dm[:id], [!]discord:guild:id, [!]discord:channel:id, [!]tui, [!]internal",
);

const WhenSchema = vb.union([
  ConditionStringSchema,
  vb.pipe(vb.array(ConditionStringSchema), vb.minLength(1)),
]);

const LogicModeSchema = vb.exactOptional(vb.picklist(["and", "or"]), "or");

const BlockActionSchema = vb.literal("load");

const PathActionSchema = vb.picklist(["allow", "deny"]);

const BlockRuleSchema = vb.strictObject({
  action: BlockActionSchema,
  mode: LogicModeSchema,
  when: WhenSchema,
});

const PathRuleSchema = vb.strictObject({
  action: PathActionSchema,
  mode: LogicModeSchema,
  when: WhenSchema,
});

const ConditionsConfigSchema = vb.strictObject({
  blocks: vb.exactOptional(vb.record(nonEmptyString, BlockRuleSchema), {}),
  memories: vb.exactOptional(vb.record(nonEmptyString, PathRuleSchema), {}),
  workspace: vb.exactOptional(vb.record(nonEmptyString, PathRuleSchema), {}),
});

type ConditionsConfig = vb.InferOutput<typeof ConditionsConfigSchema>;
type BlockRule = vb.InferOutput<typeof BlockRuleSchema>;
type PathRule = vb.InferOutput<typeof PathRuleSchema>;
type Condition = vb.InferOutput<typeof ConditionStringSchema>;

export {
  ConditionsConfigSchema,
  BlockRuleSchema,
  PathRuleSchema,
  ConditionStringSchema as ConditionSchema,
  WhenSchema,
  LogicModeSchema,
};
export type { ConditionsConfig, BlockRule, PathRule, Condition };
