import type { KvoxChatMessage } from '@marinoscar/kvox-api/ports';
import { nextAskMove, scenarioStructuredAnswer, type KvoxScenarioMeeting } from '@marinoscar/kvox-api/testing';

import type { MockResponder, MockToolCall } from './openai-compatible-mock';

// =============================================================================
// The scripted model of the graph and Ask e2e (marinoscar/kvox#586)
// =============================================================================
//
// What the model "knows" is the synthetic meetings of tests/fixtures/graph; how
// it reads a prompt and plans an Ask turn is the package's own scripted model
// (`scenarioStructuredAnswer`, `nextAskMove` of `@marinoscar/kvox-api/testing`,
// the bare host's), so no prompt-reading code lives here (ADR-0001). This file
// only maps the Chat Completions wire to those two functions:
//
//   response_format json_schema `<name>`  -> scenarioStructuredAnswer(name, ...)
//   tools present                         -> nextAskMove(messages, tool_choice)
//   anything else (a note)                -> undefined: the mock's note text
//
// Nobody names a ATTENDED row here (`attended: false`): the transcripts' named
// speakers are what the extraction turns into ATTENDED rows, which the e2e
// asserts (the D4 leftover).
// =============================================================================

/** The meetings of tests/fixtures/graph, as the model extracts them. */
export const GRAPH_MEETINGS: readonly KvoxScenarioMeeting[] = [
  {
    title: 'Weekly sync with Morgan Placeholder',
    people: [
      { label: 'Morgan Placeholder', quote: 'Thanks Morgan', attended: false },
      { label: 'Jamie Fixture', quote: 'Jamie Fixture reports to me', attended: false },
      { label: 'Jordan Sample', quote: 'Jordan, can you send the budget draft', attended: false },
    ],
    relations: [{ type: 'REPORTS_TO', from: 'Jamie Fixture', to: 'Morgan Placeholder', quote: 'Jamie Fixture reports to me on the platform team.' }],
    commitments: [
      {
        owner: 'Jordan Sample',
        counterparty: 'Morgan Placeholder',
        title: 'Send the budget draft',
        statement: 'Jordan Sample will send the budget draft to Morgan Placeholder by Friday.',
        status: 'open',
        quote: 'I will send the budget draft to Morgan by Friday.',
      },
      {
        owner: 'Jordan Sample',
        counterparty: null,
        title: 'Finish the vendor review',
        statement: 'Jordan Sample finished the vendor review.',
        status: 'done',
        quote: 'I also finished the vendor review last week.',
      },
    ],
  },
  {
    title: 'Jordan and Jamie standup',
    people: [
      { label: 'Jordan Sample', quote: 'Morning Jordan', attended: false },
      { label: 'Jamie Fixture', quote: 'Morning Jamie', attended: false },
    ],
    relations: [],
    commitments: [],
  },
  {
    // Nobody says whom Quinn reports to: the e2e sets it by hand.
    title: 'Data platform review with Riley Demo',
    people: [
      { label: 'Riley Demo', quote: 'The backlog is down to twelve items, Riley.', attended: false },
      { label: 'Quinn Testcase', quote: 'Thanks for joining, Quinn.', attended: false },
    ],
    relations: [],
    commitments: [],
  },
];

/** The reference questions (the epic's v1 acceptance bar), and the one the manual edit answers. */
export const QUESTIONS = {
  actionItems: 'What are the action items from Jordan?',
  bossMeetings: "What meetings have we had with Jamie's boss?",
  manualBossMeetings: "What meetings have we had with Quinn's boss?",
} as const;

interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

const text = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : '';

/** The Chat Completions messages as KVOX_AI's chat messages. */
function toKvoxMessages(messages: WireMessage[]): KvoxChatMessage[] {
  return messages.map((message): KvoxChatMessage => {
    if (message.role === 'tool') return { role: 'tool', toolCallId: message.tool_call_id ?? '', content: text(message.content) };
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content == null ? null : text(message.content),
        ...(message.tool_calls
          ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') })) }
          : {}),
      };
    }
    if (message.role === 'system' || message.role === 'developer') return { role: 'system', content: text(message.content) };
    return { role: 'user', content: text(message.content) };
  });
}

/** The scripted model, for `startOpenAiCompatibleMock(noteText, scriptedModel(...))`. */
export function scriptedModel(meetings: readonly KvoxScenarioMeeting[] = GRAPH_MEETINGS): MockResponder {
  let calls = 0;
  return (body) => {
    const messages = (body.messages ?? []) as WireMessage[];
    const format = body.response_format as { type?: string; json_schema?: { name?: string } } | undefined;
    if (format?.type === 'json_schema' && format.json_schema?.name) {
      const user = messages.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n');
      const answer = scenarioStructuredAnswer(format.json_schema.name, user, meetings);
      return answer === undefined ? undefined : { text: JSON.stringify(answer) };
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const move = nextAskMove(toKvoxMessages(messages), body.tool_choice === 'none' ? 'none' : 'auto');
      if ('answer' in move) return { text: move.answer };
      calls += 1;
      const call: MockToolCall = { id: `call_${calls}`, name: move.tool, arguments: move.args };
      return { toolCalls: [call] };
    }
    return undefined;
  };
}
