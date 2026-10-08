import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DISCLAIMER } from "./disclaimer.js";
import { PatentInputError, PatentService, PatentSourceError } from "./patents.js";

const optionalText = (max: number) => z.string().trim().max(max).optional();

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function render(payload: Record<string, unknown>, isError = false) {
  const body = { disclaimer: DISCLAIMER, ...payload };
  return {
    isError,
    content: [{ type: "text" as const, text: `${DISCLAIMER}\n\n${JSON.stringify(body, null, 2)}` }]
  };
}

async function run(work: () => Promise<unknown>) {
  try {
    const value = await work();
    const payload = value && typeof value === "object" ? value as Record<string, unknown> : { result: value };
    return render(payload);
  } catch (error) {
    const message = error instanceof PatentInputError || error instanceof PatentSourceError
      ? error.message
      : "The patent office request could not be completed.";
    return render({ patents: [], error: message }, true);
  }
}

export function registerPatentTools(server: McpServer, service: PatentService) {
  server.registerTool(
    "search_patents",
    {
      title: "Search patents",
      description: "Search public US patent records by keywords, claim language, CPC class, assignee, inventor, or grant date. Every number in the result was returned by USPTO. Not legal advice.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        keywords: optionalText(400).describe("Words to find in the application or title and abstract."),
        claims: optionalText(2000).describe("Claim language. USPTO matches these words across the file wrapper."),
        cpc: optionalText(30).describe("CPC symbol, such as H04L or C07H19/207."),
        assignee: optionalText(200).describe("Applicant or assignee name."),
        inventor: optionalText(200).describe("Inventor name."),
        dateFrom: optionalText(10).describe("Grant or publication date from, YYYY-MM-DD."),
        dateTo: optionalText(10).describe("Grant or publication date to, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum hits, 1 to 25.")
      }
    },
    async (args) => run(() => service.search({
      keywords: blankToUndefined(args.keywords),
      claims: blankToUndefined(args.claims),
      cpc: blankToUndefined(args.cpc),
      assignee: blankToUndefined(args.assignee),
      inventor: blankToUndefined(args.inventor),
      dateFrom: blankToUndefined(args.dateFrom),
      dateTo: blankToUndefined(args.dateTo),
      limit: args.limit
    }))
  );

  server.registerTool(
    "get_patent",
    {
      title: "Get patent details",
      description: "Fetch one US patent's title, abstract, claims, status, family, and citations from USPTO. Missing text is omitted rather than filled in. Not legal advice.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        patentNumber: z.string().trim().min(4).max(32).describe("US patent or publication number, such as US10000000 or 10000000.")
      }
    },
    async (args) => run(() => service.getPatent(args.patentNumber))
  );

  server.registerTool(
    "find_patent_citations",
    {
      title: "Find citing and cited patents",
      description: "List documents cited by a US patent and documents that cite it, using USPTO grant references and USPTO office-action citations. The PatentsView citation graph is paused. Not legal advice.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        patentNumber: z.string().trim().min(4).max(32).describe("Patent or publication number."),
        direction: z.enum(["citing", "cited_by", "both"]).optional().describe("citing: documents that cite this patent. cited_by: documents this patent cites. both is the default.")
      }
    },
    async (args) => run(async () => {
      const direction = args.direction ?? "both";
      const result = await service.citations(args.patentNumber, direction);
      return { ...result, direction };
    })
  );

  server.registerTool(
    "search_prior_art",
    {
      title: "Search prior art",
      description: "Turn an idea description into a public-patent search and return the closest records the offices actually returned, with Google Patents links. Ranking counts overlapping words. It is not a patentability opinion. Not legal advice.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        idea: z.string().trim().min(20).max(4000).describe("What the invention is, in plain language."),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum patents to return.")
      }
    },
    async (args) => run(() => service.priorArt(args.idea, args.limit))
  );
}
