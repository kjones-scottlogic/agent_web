// Minimal API server that keeps the Anthropic API key out of the browser.
// Run with `npm run server`; the Angular dev server proxies /api to it (see src/proxy.conf.json).
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { ChatRequest, ChatResponse } from '../src/app/chat/chat-api.ts';
import { type AgentDefinition, query } from '@anthropic-ai/claude-agent-sdk';
import type { Finding } from './models/finding.ts';
import type { ResearchOutput } from './models/research-output.ts';
import type { CoverageReport } from './models/coverage-report.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
//const MODEL = 'claude-opus-5-5';
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;
const COVERAGE_THRESHOLD = 0.9;
const MAX_REFINEMENT_ITERATIONS = 3;

// Reads ANTHROPIC_API_KEY (or another configured credential) from the environment.
const client = new Anthropic();

const Subtopics = z.object({
  subtopics: z.array(z.string()).min(3),
});

const webSearchAgent: AgentDefinition = {
  description: 'Search the web for information about a topic.',
  prompt: `
    Search for information on the given topic.
    Return your findings as a JSON array. Each finding is an object with fields:
    - claim: string
    - source_url: string
    - document_name: string (the source page title)
    - page_number: null
    - confidence: "high" | "medium" | "low"
  `,
  tools: ['WebSearch'],
};

const docAnalysisAgent: AgentDefinition = {
  description: 'Analyses documents and returns findings with page references',
  prompt: `
    Analyse the provided documents.
    Return your findings as a JSON array. Each finding is an object with fields:
    - claim: string
    - source_url: string (empty string for local documents)
    - document_name: string
    - page_number: number or null
    - confidence: "high" | "medium" | "low"
  `,
  tools: ['Read', 'Grep'],
};

// Builds the synthesis subagent with the findings gathered from the web-search and doc-analysis subagents.
function createSynthesisAgent(outputs: ResearchOutput[]): AgentDefinition {
  const findings = outputs.flatMap((output) => output.findings);
  const findingsBy = (agent: string) =>
    JSON.stringify(
      findings.filter((finding) => finding.retrieved_by === agent),
      null,
      2,
    );

  return {
    description: 'Synthesises findings from other subagents into a report',
    prompt: `
      Synthesise the following research findings into a coherent report.
      Every claim MUST include a citation with source URL and page number.

      <web-search-findings>
      ${findingsBy('web-search')}
      </web-search-findings>
      <doc-analysis-findings>
      ${findingsBy('doc-analysis')}
      </doc-analysis-findings>

      Output a report where every factual claim links to its source.
    `,
    tools: [],
  };
}

// A finding as a subagent reports it; retrieved_by is filled in from the subagent's name.
const SubagentFinding = z.object({
  claim: z.string(),
  source_url: z.string().default(''),
  document_name: z.string().default(''),
  page_number: z.number().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']),
});

// Extracts the JSON array of findings from a subagent's report, skipping any that don't match.
function parseFindings(report: string, retrievedBy: string): Finding[] {
  const fenced = report.match(/```(?:json)?\s*([\s\S]*?)```/);
  const json = fenced ? fenced[1] : report.slice(report.indexOf('['), report.lastIndexOf(']') + 1);

  let items: unknown;
  try {
    items = JSON.parse(json);
  } catch {
    return [];
  }

  return (Array.isArray(items) ? items : [items]).flatMap((item) => {
    const parsed = SubagentFinding.safeParse(item);
    return parsed.success ? [{ ...parsed.data, retrieved_by: retrievedBy }] : [];
  });
}

// Runs a comprehensive query that researches subtopics via parallel agents and synthesizes findings in a single query call.
async function runComprehensiveQuery(
  topic: string,
  subtopics: string[],
): Promise<{ outputs: ResearchOutput[]; report: string; summary: string }> {
  const outputs: ResearchOutput[] = [];
  let report = '';
  let summary = '';

  const subtopicsStr = subtopics.join(', ');

  const queryResponse = query({
    prompt: `
      Produce a comprehensive research report on: ${topic}

      Research the following subtopics: ${subtopicsStr}

      For EACH subtopic:
      1. Invoke the doc-analysis and web-search subagents in parallel — emit both Agent tool calls in a single response
      2. doc-analysis: analyse documents in ./docs for information about the subtopic
      3. web-search: search the web for current information about the subtopic

      After gathering all findings across all subtopics, invoke the synthesis subagent to produce a comprehensive, fully-cited report synthesizing all findings.

      Do not use the general-purpose agent.
    `,
    options: {
      model: MODEL,
      allowedTools: ['Agent', 'WebSearch', 'Read', 'Grep'],
      thinking: { budgetTokens: MAX_TOKENS, type: 'enabled' },
      agents: {
        'web-search': webSearchAgent,
        'doc-analysis': docAnalysisAgent,
        synthesis: {
          description: 'Synthesises research findings into a comprehensive report',
          prompt: `
            Synthesise all gathered research findings into a comprehensive, coherent report.
            Every factual claim MUST include a citation with source URL and page number.
            Organize findings by subtopic when appropriate. Produce a well-structured report.
          `,
          tools: [],
        },
      },
      hooks: {
        SubagentStop: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'SubagentStop') {
                  if (input.agent_type === 'synthesis') {
                    // The synthesis agent's output is the full report.
                    report = input.last_assistant_message ?? '';
                    console.log(`[${topic}] synthesis: report generated`);
                  } else {
                    // Research agents return findings.
                    const findings = parseFindings(
                      input.last_assistant_message ?? '',
                      input.agent_type,
                    );
                    console.log(`[${topic}] ${input.agent_type}: ${findings.length} findings`);
                    const matchingSubtopic = subtopics.find(
                      (st) =>
                        input.last_assistant_message?.toLowerCase().includes(st.toLowerCase()) ||
                        st.toLowerCase().includes(input.agent_type),
                    );
                    outputs.push({
                      findings,
                      query: matchingSubtopic || topic,
                      timestamp: new Date().toISOString(),
                    });
                  }
                }
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  // Process all messages; both research and synthesis happen within this single query call.
  for await (const message of queryResponse) {
    if (message.type === 'result' && message.subtype === 'success') {
      // The coordinator's final reply may contain the summary paragraph.
      summary = message.result;
    }
  }

  return { outputs, report, summary };
}

// Has the coordinator send the gathered findings to the synthesis subagent for a full report,
// then summarise that report in one paragraph.
async function synthesiseReport(
  topic: string,
  outputs: ResearchOutput[],
): Promise<{ report: string; summary: string }> {
  let report = '';
  let summary = '';

  const queryResponse = query({
    prompt: `
      The synthesis subagent has already been given all of the research findings for ${topic}.
      Call the synthesis subagent now to produce the full report. Do not ask any questions and do not do any research yourself.
      When it returns the report, reply with a single paragraph summarising the report.
    `,
    options: {
      model: MODEL,
      allowedTools: ['Agent'],
      thinking: { budgetTokens: MAX_TOKENS, type: 'enabled' },
      agents: {
        synthesis: createSynthesisAgent(outputs),
      },
      hooks: {
        // The synthesis subagent's last message is the full report.
        SubagentStop: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'SubagentStop' && input.agent_type === 'synthesis') {
                  report = input.last_assistant_message ?? '';
                }
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  for await (const message of queryResponse) {
    // The coordinator's final reply is the one-paragraph summary.
    if (message.type === 'result' && message.subtype === 'success') {
      summary = message.result;
    }
  }

  return { report, summary };
}

// Evaluates coverage completeness across all subtopics.
async function evaluateCoverage(
  subtopics: string[],
  outputs: ResearchOutput[],
): Promise<CoverageReport> {
  const covered = subtopics.filter((st) =>
    outputs.some((output) => output.query === st && output.findings.length > 0),
  );
  const gaps = subtopics.filter((st) => !covered.includes(st));
  const completeness = covered.length / subtopics.length;

  console.log(`Coverage evaluation: ${covered.length}/${subtopics.length} subtopics covered`);
  if (gaps.length > 0) {
    console.log(`Gaps detected: ${gaps.join(', ')}`);
  }

  return { covered, gaps, completeness };
}

// Writes the report to ./reports/<topic>-<timestamp>.md.
async function writeReport(topic: string, report: string): Promise<void> {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = `reports/${slug}-${timestamp}.md`;

  await mkdir('reports', { recursive: true });
  await writeFile(filePath, report, 'utf8');
  console.log(`Report written to ${filePath}`);
}

async function chat(body: ChatRequest): Promise<ChatResponse> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: `
          List ALL major subtopics for: ${body.topic}.
          Ensure comprehensive breadth — missing an entire category is a critical failure.
          Return as JSON array.
        `,
      },
    ],
    output_config: { format: betaZodOutputFormat(Subtopics) },
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    throw new RefusalError(`Claude declined to respond${category ? ` (${category})` : ''}.`);
  }

  if (!response.parsed_output) {
    throw new Error(`Coordinator returned no subtopics (stop reason: ${response.stop_reason}).`);
  }

  const { subtopics } = response.parsed_output;

  let allOutputs: ResearchOutput[] = [];
  let coverage: CoverageReport = { covered: [], gaps: subtopics, completeness: 0 };
  let iterations = 0;
  let finalReport = '';
  let finalSummary = '';

  while (coverage.completeness < COVERAGE_THRESHOLD && iterations < MAX_REFINEMENT_ITERATIONS) {
    const subtopicsToQuery = iterations === 0 ? subtopics : coverage.gaps;
    console.log(`[Iteration ${iterations + 1}] Researching and synthesizing ${subtopicsToQuery.length} subtopic(s)`);

    try {
      const { outputs, report, summary } = await runComprehensiveQuery(body.topic, subtopicsToQuery);
      allOutputs.push(...outputs);
      finalReport = report;
      finalSummary = summary;
    } catch (err) {
      console.error(`Comprehensive query failed:`, err);
    }

    coverage = await evaluateCoverage(subtopics, allOutputs);
    iterations++;
  }

  if (coverage.completeness < COVERAGE_THRESHOLD) {
    console.log(
      `Coverage threshold not met after ${iterations} iterations. Proceeding with ${Math.round(coverage.completeness * 100)}% coverage.`,
    );
  } else {
    console.log(
      `Coverage threshold met (${Math.round(coverage.completeness * 100)}%) after ${iterations} iteration(s).`,
    );
  }

  await writeReport(body.topic, finalReport);

  const subtopicList = subtopics.map((topic, i) => `${i + 1}. ${topic}`).join('\n');
  const text = `Subtopics:\n${subtopicList}\n\nSummary:\n${finalSummary}`;
  return { text };
}

class RefusalError extends Error {}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    send(res, 404, { error: 'Not found' });
    return;
  }

  let body: ChatRequest;
  try {
    body = (await readJson(req)) as ChatRequest;
    if (typeof body?.topic !== 'string' || !body.topic.trim()) {
      throw new Error();
    }
  } catch {
    send(res, 400, { error: 'Expected a JSON body with a non-empty "topic" string.' });
    return;
  }

  try {
    send(res, 200, await chat(body));
  } catch (error) {
    if (error instanceof RefusalError) {
      send(res, 422, { error: error.message });
    } else if (error instanceof Anthropic.AuthenticationError) {
      console.error('Authentication failed - is ANTHROPIC_API_KEY set?');
      send(res, 502, { error: 'The server could not authenticate with the Anthropic API.' });
    } else if (error instanceof Anthropic.RateLimitError) {
      send(res, 429, { error: 'Rate limited by the Anthropic API - please try again shortly.' });
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${error.status}:`, error.message);
      send(res, 502, { error: `Anthropic API error (${error.status ?? 'network'}).` });
    } else {
      console.error(error);
      send(res, 500, { error: 'Unexpected server error.' });
    }
  }
}).listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set - add it to .env (see .env.example).');
  }
});
