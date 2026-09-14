# 0031. A recording carries references, never resolved values

- Status: accepted
- Date: 2026-09-11

## Context and problem statement

A recording of a case that signs in put the account's email address and its
password into `ir.json`, as themselves. The generated test then carried the
address into the consumer's repository, in a comment a rewrite pass wrote
about what it had just read.

Neither is a new mechanism failing. Both are the same old one not applying.
ccqa has always symbolised `${VAR}` back out of a recording, but the map it
scrubs against is built from the variable names **the case's own text
mentions**. A `spec.yaml` step reads `open ${APP_URL} and sign in as
${TEST_EMAIL}`, so the map has both. A markdown case written for a person
reads "sign in", and the values it signs in with come from the project's env
file — which the case has no reason to name. The map is then empty, and every
value the browser saw is a literal the recording keeps.

The generated-code half follows from the same emptiness. Once a value is in
the route, it is in the mechanical draft, in the fix pass's prompt, and in
whatever a rewrite pass decides to explain in a comment.

## Considered options

- **Ask the case to name its variables.** Restores the old contract by making
  every project rewrite its cases in ccqa's vocabulary — which is the thing
  ADR-0029 exists not to require.
- **Scrub against every variable in the environment.** Correct in principle,
  and unusable: a recording would have `${HOME}`, `${TERM}` and `${PWD}`
  substituted into locators and asserted text.
- **Scrub against the variables ccqa itself loaded**, and refuse to write a
  generated file that still holds one of their values.

## Decision outcome

Chosen option: "the variables ccqa itself loaded", because that set is exactly
the project's own — a hub profile it pulled, an `envFiles` entry it read — and
nothing else in the environment belongs to the case at all.

Three rules, each at the moment it can be enforced:

1. **The route is symbolised against the loaded set**, whether or not the case
   names it. A value shorter than eight characters is left alone: a port or a
   stage name collides with ordinary page text more often than it protects
   anything, and a case that wants exact treatment for such a variable can
   still name it in its own text.
2. **A value typed into a password field is not recorded as itself.** Where it
   resolved to a reference the action is kept as usual; where it did not, the
   action is dropped and the recording says why. The recorder marks such a
   command with a `CCQA_SECRET=1` prefix, the same channel `CCQA_STEP` and
   `CCQA_ASSERT` already use, and a locator that addresses a password input by
   its own attribute is treated the same way without being told.
3. **A generated file holding a loaded value is refused, not laundered.** Code
   is not a recording: a credential a model wrote into a comment is not a
   reference the test needs, so the answer is to reject the file and ask
   again — twice, and then fail the generation — rather than substitute a
   variable into prose that should not have mentioned it. The check runs
   again at the write itself, which every generation path reaches.

`ccqa generate` also reads the saved route back and names any variable whose
value it still holds. A recording made before the project pointed ccqa at its
env file keeps those literals, and nothing else would ever look.

### Consequences

- Good: a case written as prose gets the same treatment as one that names its
  variables, which is what makes a project's own markdown usable at all.
- Good: the refusal is a fact about the file, so it does not depend on a model
  agreeing that something is a secret.
- Bad / cost: the eight-character floor is a guess. A shorter credential is
  not symbolised, and the case has to name the variable to get it back.
- Bad / cost: dropping an unrouted password leaves the generated test unable
  to sign in, which fails loudly during generation. That is the intended
  direction — the repair is to route the value through the project's env file
  — but it is a hard stop rather than a warning.
- Follow-up: the eight-character floor exists because the scrub is textual —
  it replaces occurrences in a command line, before anything is parsed into
  fields. A field-aware pass could symbolise a `fill` whose value *equals* a
  loaded value whatever its length, with no collision risk, and drop the floor
  for that case. Worth doing where the recording is parsed.

### Confirmation

`tests/e2e/scenarios/record-markdown-secrets.stub.test.ts` records a markdown
case whose credentials come from an `envFiles` entry, with the browser and
Claude both faked, and asserts that `ir.json` holds `${TEST_EMAIL}` and
`${TEST_PASSWORD}`, that a password typed literally appears nowhere under
`.ccqa/`, and that the generated test holds neither value. Unit tests cover
the map's floor, the password rule's two signals, and the generation refusal.

## More information

- [ADR-0029](./0029-ccqa-ships-mechanism-the-project-supplies-the-facts.md) —
  why a project's cases are not written in ccqa's vocabulary.
- `src/runtime/env-scrub.ts`, `src/runtime/literal-scrub.ts`,
  `src/targets/llm-engine.ts`.
