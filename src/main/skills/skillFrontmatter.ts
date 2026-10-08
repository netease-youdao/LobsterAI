import yaml from 'js-yaml';

// A top-level `description:` line. OpenClaw also accepts a quoted key.
const DESCRIPTION_LINE_RE = /^(?:description|"description"|'description')[ \t]*:[ \t]*(.*?)[ \t]*$/m;
// `|`, `>-`, `|2` and the like start a block scalar whose text is on the following lines.
const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

const stripMatchingQuotes = (value: string): string => {
  const quote = value[0];
  return value.length > 1 && (quote === '"' || quote === '\'') && value.endsWith(quote)
    ? value.slice(1, -1)
    : value;
};

const quoteFreeformDescription = (block: string): string | null => {
  const value = block.match(DESCRIPTION_LINE_RE)?.[1];
  if (!value || BLOCK_SCALAR_HEADER_RE.test(value)) return null;
  const quoted = `description: ${JSON.stringify(stripMatchingQuotes(value))}`;
  // A replacer function keeps `$&`-style sequences in the description literal.
  return block.replace(DESCRIPTION_LINE_RE, () => quoted);
};

/**
 * Parses the YAML of a SKILL.md frontmatter block the way OpenClaw does.
 *
 * Hand-written skills often carry a free-form description that is not valid
 * YAML, such as `description: Use when: ...`, `[Beta] ...`, `@scope/...` or
 * `*Experimental`. OpenClaw quotes that line and parses again instead of
 * dropping the skill, so do the same: otherwise the skills list loses the
 * name, description and version of a skill the agent loads just fine. Any
 * other YAML error still throws (the original one), because OpenClaw refuses
 * to load such a skill too.
 */
export const loadSkillFrontmatterYaml = (block: string): unknown => {
  try {
    return yaml.load(block);
  } catch (error) {
    const repaired = quoteFreeformDescription(block);
    if (repaired === null) throw error;
    try {
      return yaml.load(repaired);
    } catch {
      throw error;
    }
  }
};
