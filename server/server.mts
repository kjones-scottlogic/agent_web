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
const RESEARCH_MODEL = 'claude-haiku-4-5';
const CONSOLIDATION_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4000;
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

// Runs research for a single subtopic with parallel research agents and synthesis, all in one query.
async function runSubtopicQueryWithParallelAgents(
  subtopic: string,
  onProgress?: ProgressCallback,
  originalSubtopics?: string[],
  allOutputs?: ResearchOutput[],
): Promise<ResearchOutput[]> {
  const outputs: ResearchOutput[] = [];
  let synthesisReport = '';

  const synthesisAgent: AgentDefinition = {
    description: `Synthesise research findings for "${subtopic}"`,
    prompt: `
      Synthesise the research findings for "${subtopic}" into a coherent, fully-cited report.
      Every claim MUST include a citation with source URL and page number.
    `,
    tools: [],
  };

  const queryResponse = query({
    prompt: `
      Research "${subtopic}" thoroughly. Invoke the web-search and doc-analysis subagents in parallel — emit both Agent tool calls in a single response.
      After both subagents return their findings, invoke the synthesis subagent to produce a synthesised report.

      - web-search subagent: Search the web for current information about "${subtopic}".
      - doc-analysis subagent: Analyse documents in ./docs for information about "${subtopic}".
      - synthesis subagent: After gathering findings, synthesise them into a report with citations.

      Do not do any research yourself; delegate all work to the subagents.
    `,
    options: {
      model: RESEARCH_MODEL,
      allowedTools: ['Agent', 'WebSearch', 'Read', 'Grep'],
      thinking: { budgetTokens: MAX_TOKENS, type: 'enabled' },
      agents: {
        'web-search': webSearchAgent,
        'doc-analysis': docAnalysisAgent,
        synthesis: synthesisAgent,
      },
      hooks: {
        SubagentStop: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'SubagentStop') {
                  if (input.agent_type === 'synthesis') {
                    synthesisReport = input.last_assistant_message ?? '';
                    console.log(`[${subtopic}] synthesis: report generated`);
                  } else {
                    const findings = parseFindings(
                      input.last_assistant_message ?? '',
                      input.agent_type,
                    );
                    console.log(`[${subtopic}] ${input.agent_type}: ${findings.length} findings`);
                    outputs.push({ findings, query: subtopic, timestamp: new Date().toISOString() });
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

  for await (const _message of queryResponse) {
    // SDK executes research agents in parallel, then synthesis — all within one query.
  }

  if (originalSubtopics && allOutputs) {
    allOutputs.push(...outputs);
    const covered = originalSubtopics.filter((st) =>
      allOutputs.some((output) => output.query === st && output.findings.length > 0),
    );
    const percentage = Math.round((covered.length / originalSubtopics.length) * 60) + 10;
    onProgress?.({ type: 'status', percentage, message: `Completed: ${subtopic}` });
  }

  return outputs;
}

// Runs research queries for subtopics in parallel (each with research and synthesis in the same query).
async function runComprehensiveQuery(
  topic: string,
  subtopics: string[],
  onProgress?: ProgressCallback,
  originalSubtopics?: string[],
  accumulatedOutputs?: ResearchOutput[],
): Promise<{ outputs: ResearchOutput[]; report: string; summary: string }> {
  // Use accumulated outputs from previous iterations, or start fresh
  const allOutputs = accumulatedOutputs ?? [];
  const originals = originalSubtopics ?? subtopics;

  // Research all subtopics in parallel (each query includes web-search, doc-analysis, and synthesis)
  const outputs = (
    await Promise.all(
      subtopics.map(async (subtopic) => {
        try {
          return await runSubtopicQueryWithParallelAgents(subtopic, onProgress, originals, allOutputs);
        } catch (err) {
          console.error(`[${subtopic}] query failed:`, err);
          return [];
        }
      }),
    )
  ).flat();

  const findings = outputs.flatMap((output) => output.findings);

  const formatFinding = (f: Finding) => {
    if (f.retrieved_by === 'doc-analysis') {
      const pageRef = f.page_number ? `, page ${f.page_number}` : '';
      return `- ${f.claim} (${f.document_name}${pageRef})`;
    } else {
      return `- ${f.claim} (${f.source_url})`;
    }
  };

  const report = `Research findings for: ${topic}\n\n${findings.map(formatFinding).join('\n')}`;
  const summary = `Completed research on ${topic} across ${subtopics.length} subtopic(s).`;

  return { outputs, report, summary };
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

interface ProgressUpdate {
  type: 'status' | 'summary' | 'file';
  percentage: number;
  message?: string;
  fileName?: string;
}

type ProgressCallback = (update: ProgressUpdate) => void;

async function chat(body: ChatRequest, onProgress: ProgressCallback): Promise<ChatResponse> {
  const response = await client.beta.messages.parse({
    model: RESEARCH_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: `
          Identify all distinct categories and types that make up: ${body.topic}.
          Break down the topic into high-level subtopics representing the main categories or types.
          For example, for "renewable energy," subtopics would be: solar, wind, hydroelectric, geothermal, biomass, tidal, energy storage — not cross-cutting aspects.
          Each subtopic will be researched comprehensively, including its environmental impact, economics, policy, and innovation.
          Ensure no major category or type is missing.
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

  onProgress({ type: 'status', percentage: 10, message: `Starting research on ${subtopics.length} subtopics` });

  let allOutputs: ResearchOutput[] = [];
  let coverage: CoverageReport = { covered: [], gaps: subtopics, completeness: 0 };
  let iterations = 0;
  let finalReport = '';
  let finalSummary = '';

  while (coverage.completeness < COVERAGE_THRESHOLD && iterations < MAX_REFINEMENT_ITERATIONS) {
    const subtopicsToQuery = iterations === 0 ? subtopics : coverage.gaps;
    const iterationProgress = 10 + (iterations / MAX_REFINEMENT_ITERATIONS) * 60;

    console.log(`[Iteration ${iterations + 1}] Researching and synthesizing ${subtopicsToQuery.length} subtopic(s)`);
    onProgress({
      type: 'status',
      percentage: Math.round(iterationProgress),
      message: `Researching ${subtopicsToQuery.length} subtopic${subtopicsToQuery.length === 1 ? '' : 's'}:\n${subtopicsToQuery.map((s) => `- ${s}`).join('\n')}`,
    });

    try {
      const { outputs, report, summary } = await runComprehensiveQuery(body.topic, subtopicsToQuery, onProgress, subtopics, allOutputs);
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

  onProgress({ type: 'status', percentage: 75, message: 'Consolidating findings...' });

  // Perform final consolidation using Sonnet
  const allFindings = allOutputs.flatMap((output) => output.findings);
  const findingsJson = JSON.stringify(allFindings, null, 2);

  const consolidationPrompt = `
    Consolidate the following research findings into a comprehensive, well-organized report on ${body.topic}.
    Every factual claim MUST include proper citations with source information.
    Organize by subtopic when appropriate. Produce a coherent, professional report.

    <findings>
    ${findingsJson}
    </findings>
  `;

  const sonnetResponse = await client.messages.create({
    model: CONSOLIDATION_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: consolidationPrompt,
      },
    ],
  });

  finalReport = sonnetResponse.content[0].type === 'text' ? sonnetResponse.content[0].text : finalReport;
  finalSummary = finalReport.split('\n').slice(0, 3).join(' ').substring(0, 200);

  const slug = body.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `reports/${slug}-${timestamp}.md`;

  await writeReport(body.topic, finalReport);

  onProgress({ type: 'summary', percentage: 90, message: finalSummary });
  onProgress({ type: 'file', percentage: 100, fileName });

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
    // Send as Server-Sent Events stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const onProgress = (update: ProgressUpdate) => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
    };

    const result = await chat(body, onProgress);

    // Send final result
    res.write(`data: ${JSON.stringify({ type: 'complete', percentage: 100, result })}\n\n`);
    res.end();
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    if (error instanceof RefusalError) {
      res.end(JSON.stringify({ error: error.message }));
    } else if (error instanceof Anthropic.AuthenticationError) {
      console.error('Authentication failed - is ANTHROPIC_API_KEY set?');
      res.end(JSON.stringify({ error: 'The server could not authenticate with the Anthropic API.' }));
    } else if (error instanceof Anthropic.RateLimitError) {
      res.end(JSON.stringify({ error: 'Rate limited by the Anthropic API - please try again shortly.' }));
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${error.status}:`, error.message);
      res.end(JSON.stringify({ error: `Anthropic API error (${error.status ?? 'network'}).` }));
    } else {
      console.error(error);
      res.end(JSON.stringify({ error: 'Unexpected server error.' }));
    }
  }
}).listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set - add it to .env (see .env.example).');
  }
});
