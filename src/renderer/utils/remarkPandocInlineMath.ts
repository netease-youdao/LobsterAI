import type { Data, Processor } from 'unified';

// Derived from remark-parse's `Data` registration so the types match the
// micromark remark actually runs; the hoisted `micromark-util-types` is an
// older major.
type MicromarkExtension = NonNullable<Data['micromarkExtensions']>[number];
type Construct = Exclude<NonNullable<MicromarkExtension['text']>[string], unknown[] | undefined>;
type Tokenizer = Construct['tokenize'];
type State = Parameters<Tokenizer>[1];
type Code = Parameters<State>[0];

const DOLLAR_SIGN = 36;
const DIGIT_ZERO = 48;
const DIGIT_NINE = 57;
const MATH_TEXT_CONSTRUCT = 'mathText';
// Lookahead events are discarded. micromark only requires consumed codes to
// belong to an open token, so a core token type is enough.
const CHECK_TOKEN = 'data';

// A missing character (null in micromark, -1 past the end of a Lezer inline
// section) counts as space. micromark also encodes line endings, tabs and
// virtual spaces as negative codes.
const isSpaceOrBoundary = (code: number | null): boolean => code === null || code < 0
  || /\s/.test(String.fromCharCode(code));

const isAsciiDigit = (code: number | null): boolean => code !== null
  && code >= DIGIT_ZERO && code <= DIGIT_NINE;

/**
 * Pandoc's single-dollar delimiter rule, shared by chat replies and the
 * Markdown editor preview: an opening `$` must be followed by a non-space
 * character.
 */
export const canOpenSingleDollarMath = (next: number | null): boolean => !isSpaceOrBoundary(next);

/**
 * A closing `$` must follow a non-space character and must not be followed by
 * a digit, so currency such as `$3/$15` stays text.
 */
export const canCloseSingleDollarMath = (previous: number | null, next: number | null): boolean =>
  !isSpaceOrBoundary(previous) && !isAsciiDigit(next);

/**
 * Looks ahead over the span remark-math would parse from an opening `$` and
 * accepts it only when both delimiters follow Pandoc's rule. `$$` math keeps
 * remark-math's own rules.
 */
const tokenizePandocDelimiters: Tokenizer = function (effects, ok, nok) {
  let previous: Code = null;
  let beforeClosing: Code = null;
  let closingSize = 0;
  return start;

  function start(code: Code): State | undefined {
    effects.enter(CHECK_TOKEN);
    effects.consume(code);
    return afterOpening;
  }

  function afterOpening(code: Code): State | undefined {
    if (code === DOLLAR_SIGN) return accept(code);
    return canOpenSingleDollarMath(code) ? inside(code) : nok(code);
  }

  function inside(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === DOLLAR_SIGN) {
      beforeClosing = previous;
      closingSize = 0;
      return closingSequence(code);
    }
    previous = code;
    effects.consume(code);
    return inside;
  }

  function closingSequence(code: Code): State | undefined {
    if (code === DOLLAR_SIGN) {
      closingSize += 1;
      effects.consume(code);
      return closingSequence;
    }
    // As in remark-math, a dollar run of another length is formula content.
    if (closingSize !== 1) {
      previous = DOLLAR_SIGN;
      return inside(code);
    }
    return canCloseSingleDollarMath(beforeClosing, code) ? accept(code) : nok(code);
  }

  function accept(code: Code): State | undefined {
    effects.exit(CHECK_TOKEN);
    return ok(code);
  }
};

const pandocDelimiters: Construct = { tokenize: tokenizePandocDelimiters, partial: true };

const withPandocDelimiters = (mathText: Construct): Construct => ({
  ...mathText,
  tokenize(effects, ok, nok) {
    return effects.check(pandocDelimiters, mathText.tokenize.call(this, effects, ok, nok), nok);
  },
});

/**
 * remark-math pairs any two single dollars, so currency such as `$3/$15`
 * became a formula. It only offers the all-or-nothing `singleDollarTextMath`
 * option, and `$...$` must keep working because the managed math prompt asks
 * models for it. Wraps the inline math construct remark-math registered, so
 * this plugin must come after remark-math.
 */
export function remarkPandocInlineMath(this: Processor): void {
  const extensions = this.data().micromarkExtensions ?? [];
  for (const [index, extension] of extensions.entries()) {
    const mathText = extension.text?.[DOLLAR_SIGN];
    if (!mathText || Array.isArray(mathText) || mathText.name !== MATH_TEXT_CONSTRUCT) continue;
    extensions[index] = {
      ...extension,
      text: { ...extension.text, [DOLLAR_SIGN]: withPandocDelimiters(mathText) },
    };
  }
}
