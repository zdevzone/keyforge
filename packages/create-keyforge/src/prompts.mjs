import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

/** Clack supplies arrow keys, Enter, Ctrl+C and terminal restoration. Pipes
 * and --yes retain deterministic defaults without entering terminal mode. */
export function createPrompter({ interactive, input = process.stdin, output = process.stdout }) {
  const streams = { input, output };
  function answer(value) {
    if (isCancel(value)) {
      cancel("Setup cancelled. No project was created.", { output });
      throw new Error("Setup cancelled.");
    }
    return value;
  }
  return {
    interactive,
    async text(question, defaultValue) {
      if (!interactive) return defaultValue;
      return (
        answer(
          await text({ message: question, defaultValue, placeholder: defaultValue, ...streams }),
        ).trim() || defaultValue
      );
    },
    async select(question, choices, defaultId) {
      if (!interactive) return defaultId;
      return answer(
        await select({
          message: question,
          initialValue: defaultId,
          options: choices.map((choice) => ({
            value: choice.id,
            label: choice.title,
            hint: choice.description,
          })),
          ...streams,
        }),
      );
    },
    async confirm(question, defaultValue) {
      if (!interactive) return defaultValue;
      return answer(await confirm({ message: question, initialValue: defaultValue, ...streams }));
    },
    close() {},
  };
}
