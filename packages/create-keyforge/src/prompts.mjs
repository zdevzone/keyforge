import { createInterface } from "node:readline/promises";

/**
 * A very small prompter: numbered choices and free text, no dependencies.
 *
 * When prompting is off — `--yes`, a pipe, a CI job — every question answers
 * with its default instead of hanging. A scaffolder that blocks forever on a
 * non-interactive terminal is a scaffolder nobody can script.
 */
export function createPrompter({ interactive, input = process.stdin, output = process.stdout }) {
  let rl = null;
  const ensure = () => (rl ??= createInterface({ input, output }));

  return {
    interactive,

    async text(question, defaultValue) {
      if (!interactive) return defaultValue;
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      const answer = (await ensure().question(`${question}${suffix}: `)).trim();
      return answer || defaultValue;
    },

    /** `choices` are {id, title, description}; returns the chosen id. */
    async select(question, choices, defaultId) {
      if (!interactive) return defaultId;
      const defaultIndex = Math.max(
        0,
        choices.findIndex((choice) => choice.id === defaultId),
      );
      output.write(`\n${question}\n`);
      choices.forEach((choice, index) => {
        const marker = index === defaultIndex ? "*" : " ";
        output.write(`  ${marker} ${index + 1}) ${choice.title} — ${choice.description}\n`);
      });
      for (;;) {
        const answer = (await ensure().question(`  choice (${defaultIndex + 1}): `)).trim();
        if (!answer) return choices[defaultIndex].id;
        const byId = choices.find((choice) => choice.id === answer);
        if (byId) return byId.id;
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
          return choices[index - 1].id;
        }
        output.write(`  Pick 1-${choices.length}.\n`);
      }
    },

    async confirm(question, defaultValue) {
      if (!interactive) return defaultValue;
      const answer = (await ensure().question(`${question} ${defaultValue ? "(Y/n)" : "(y/N)"}: `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      return answer === "y" || answer === "yes";
    },

    close() {
      rl?.close();
      rl = null;
    },
  };
}
