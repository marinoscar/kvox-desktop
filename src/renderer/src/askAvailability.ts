// What the Ask entry needs to decide, apart from React (marinoscar/kvox-desktop#22).

/** The tasks the server reports as unavailable (`GET /desktop/ai`). */
export interface UnavailableTask {
  task: string;
  reason: string;
}

/** The task id of Ask's answers. */
export const ASK_TASK = 'ask.respond';

export const ASK_UNAVAILABLE_TOOLTIP = 'Ask needs a provider with tool calling: add an OpenAI key';

/** True when the server lists `ask.respond` as unavailable. */
export function isAskUnavailable(tasks: readonly UnavailableTask[] | undefined): boolean {
  return tasks?.some((entry) => entry.task === ASK_TASK) === true;
}

