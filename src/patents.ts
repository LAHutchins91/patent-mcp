import { DISCLAIMER, PRODUCT_NAME } from "./disclaimer.js";

export class PatentInputError extends Error {}
export class PatentSourceError extends Error {}

export type FamilyMember = {
  patentNumber?: string;
  publicationNumber?: string;
  applicationNumber?: string;
  relationship?: string;
  googlePatentsUrl?: string;
  source: string;
};

export type Citation = {
  patentNumber?: string;
  publicationNumber?: string;
  applicationNumber?: string;
  googlePatentsUrl?: string;
  source: string;
};

export type PatentRecord = {
  patentNumber?: string;
  publicationNumber?: string;
  applicationNumber?: string;
  title?: string;
  abstract?: string;
  claims?: string[];
  status?: string;
  filingDate?: string;
  grantDate?: string;
  inventors: string[];
  assignees: string[];
  cpc: string[];
  family: FamilyMember[];
  cited: Citation[];
  citedBy: Citation[];
  googlePatentsUrl?: string;
  keywordOverlap?: number;
  source: string;
};

export type SearchInput = {
  keywords?: string;
  claims?: string;
  cpc?: string;
  assignee?: string;
  inventor?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  /** "any" matches a keyword on its own. The default "all" requires every keyword. */
  keywordMatch?: "all" | "any";
  /** When set, keyword text is searched in this office field instead of free text. */
  keywordField?: string;
};

export type OfficeId = {
  compact: string;
  country: string;
  usptoPatentDigits?: string;
  usptoPublication?: string;
  epoRef: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT = "PatentByOuroboros/1.0 (+https://github.com/LAHutchins91/patent-mcp)";
const USPTO_SEARCH = "https://api.uspto.gov/api/v1/patent/applications/search";
const USPTO_CITATIONS = "https://api.uspto.gov/api/v1/patent/oa/oa_citations/v2/records";

const STOP = new Set([
  "about", "above", "across", "after", "allow", "allowed", "allowing", "allows", "also", "and",
  "apart", "are", "because", "been", "before", "being", "below", "between", "both", "can", "cannot",
  "could", "comprising", "comprise", "comprises", "did", "does", "doing", "done", "during", "each",
  "for", "from", "gets", "got", "had", "has", "have", "held", "help", "helped", "helping", "helps",
  "here", "hold", "holding", "holds", "include", "included", "includes", "including", "into", "its",
  "just", "keep", "keeping", "keeps", "kept", "lets", "like", "made", "make", "makes", "making",
  "many", "method", "more", "much", "not", "onto", "only", "other", "over", "provide", "provided",
  "provides", "said", "says", "shall", "some", "such", "system", "than", "that", "the", "their",
  "them", "then", "there", "thereby", "therein", "thereof", "these", "they", "this", "those",
  "through", "under", "upon", "used", "uses", "using", "very", "via", "were", "what", "when",
  "where", "wherein", "which", "while", "will", "with", "within", "without", "would", "your",
  "device", "apparatus",
  "able", "again", "all", "another", "any", "anyone", "anything", "based", "but", "else", "even",
  "every", "everything", "few", "having", "her", "his", "how", "idea", "ideas", "let", "may",
  "maybe", "might", "most", "need", "needed", "needs", "nor", "nothing", "off", "one", "our",
  "out", "own", "per", "please", "really", "same", "she", "should", "someone", "something",
  "thing", "things", "too", "use", "want", "wanted", "wants", "was", "who", "why", "yet", "you"
]);

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function splitWords(value: string): string[] {
  return value
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

export function sanitizeWords(value: string | undefined): string[] {
  if (!value) return [];
  return splitWords(value).slice(0, 12);
}

export function googlePatentsUrl(country: string, number: string): string | undefined {
  const cc = country.toUpperCase();
  const doc = number.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || doc.length < 4) return undefined;
  const id = doc.startsWith(cc) ? doc : `${cc}${doc}`;
  if (!/^[A-Z]{2}[A-Z0-9]{4,22}$/.test(id)) return undefined;
  return `https://patents.google.com/patent/${id}/en`;
}

export function normalizeOfficeId(input: string): OfficeId {
  const compact = input.trim().replace(/[\s,/-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{4,22}$/.test(compact)) {
    throw new PatentInputError("Use a US patent or publication number such as US10000000 or 10000000.");
  }
  const country = /^[A-Z]{2}/.test(compact) ? compact.slice(0, 2) : "US";
  const publication = /^[A-Z]{2}\d{8,}A\d?$/.test(compact) ? compact : undefined;
  let usptoPatentDigits: string | undefined;
  if (!publication && country === "US") {
    const digits = compact.replace(/^[A-Z]{2}/, "").replace(/[A-Z]\d?$/, "");
    if (/^\d{5,8}$/.test(digits)) usptoPatentDigits = digits;
  }
  const withoutKind = compact.replace(/[A-Z]\d?$/, (suffix) => (/^\d/.test(compact) ? suffix : ""));
  const epoCore = /^[A-Z]{2}/.test(withoutKind) ? withoutKind : `US${withoutKind}`;
  return { compact, country, usptoPatentDigits, usptoPublication: publication, epoRef: epoCore };
}

const PRIOR_ART_TERMS = 8;

export function keywordsFromIdea(idea: string): string[] {
  const counts = new Map<string, { count: number; index: number }>();
  let index = 0;
  for (const word of splitWords(idea.toLowerCase())) {
    if (word.length < 3 || STOP.has(word)) continue;
    const existing = counts.get(word);
    if (existing) existing.count += 1;
    else counts.set(word, { count: 1, index: index++ });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].index - b[1].index)
    .map(([word]) => word)
    .slice(0, PRIOR_ART_TERMS);
}

function containsIdeaTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = term.length >= 4 ? "(?:s|es|ing)?" : "s?";
  return new RegExp(`(?:^|[^a-z0-9])${escaped}${suffix}(?:[^a-z0-9]|$)`).test(text);
}

export function overlapScore(terms: string[], patent: { title?: string; abstract?: string }): number {
  const title = (patent.title ?? "").toLowerCase();
  const abstract = (patent.abstract ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (containsIdeaTerm(title, term)) score += 2;
    else if (containsIdeaTerm(abstract, term)) score += 1;
  }
  return score;
}

export function rankByKeywordOverlap<T extends { title?: string; abstract?: string; patentNumber?: string }>(
  terms: string[],
  patents: T[]
): Array<T & { keywordOverlap: number }> {
  return patents
    .map((patent) => ({ ...patent, keywordOverlap: overlapScore(terms, patent) }))
    .sort((a, b) => b.keywordOverlap - a.keywordOverlap || (a.patentNumber ?? "").localeCompare(b.patentNumber ?? ""));
}

function keywordClause(words: string[], match: "all" | "any", field?: string): string {
  const joiner = match === "any" ? " OR " : " AND ";
  const wrapped = words.map((word) => `(${word})`).join(joiner);
  if (!field) return match === "any" && words.length > 1 ? `(${wrapped})` : wrapped;
  const value = words.length === 1 ? words[0] : wrapped;
  return `${field}:(${value})`;
}


/** Compact CPC and build a USPTO clause that still matches spaced bag values like "H04L   9/3213". */
export function normalizeCpcSymbol(input: string): string {
  const cpc = input.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-HY][0-9]{2}[A-Z0-9/]*$/.test(cpc)) {
    throw new PatentInputError("CPC class must look like H04L or C07H19/207.");
  }
  return cpc;
}

export function cpcUsptoQueryClause(input: string): string {
  const cpc = normalizeCpcSymbol(input);
  const match = /^([A-HY][0-9]{2}[A-Z])(.*)$/.exec(cpc);
  if (!match) throw new PatentInputError("CPC class must look like H04L or C07H19/207.");
  const [, subclass, rest] = match;
  if (!rest) return `applicationMetaData.cpcClassificationBag:${subclass}*`;
  // Indexed symbols often insert spaces after the subclass; allow them with a wildcard.
  return `applicationMetaData.cpcClassificationBag:${subclass}*${rest}*`;
}

export function buildUsptoBody(input: SearchInput): Json {
  const clauses: string[] = [];
  const keywords = sanitizeWords(input.keywords);
  if (keywords.length) clauses.push(keywordClause(keywords, input.keywordMatch ?? "all", input.keywordField));
  const claims = sanitizeWords(input.claims);
  if (claims.length) clauses.push(claims.map((word) => `(${word})`).join(" AND "));
  if (input.cpc) {
    clauses.push(cpcUsptoQueryClause(input.cpc));
  }
  const assignee = phrase(input.assignee);
  if (input.assignee && !assignee) throw new PatentInputError("Assignee has no searchable letters.");
  if (assignee) clauses.push(`applicationMetaData.firstApplicantName:${assignee}`);
  const inventor = phrase(input.inventor);
  if (input.inventor && !inventor) throw new PatentInputError("Inventor has no searchable letters.");
  if (inventor) clauses.push(`applicationMetaData.firstInventorName:${inventor}`);
  const rangeFilters: Json[] = [];
  if (input.dateFrom || input.dateTo) {
    if (input.dateFrom && !DATE_RE.test(input.dateFrom)) throw new PatentInputError("dateFrom must be YYYY-MM-DD.");
    if (input.dateTo && !DATE_RE.test(input.dateTo)) throw new PatentInputError("dateTo must be YYYY-MM-DD.");
    rangeFilters.push({
      field: "applicationMetaData.grantDate",
      valueFrom: input.dateFrom ?? "1790-01-01",
      valueTo: input.dateTo ?? "2999-12-31"
    });
  }
  if (!clauses.length && !rangeFilters.length) {
    throw new PatentInputError("Provide a keyword, claim phrase, CPC symbol, assignee, inventor, or date.");
  }
  const body: Json = {
    q: clauses.length ? clauses.join(" AND ") : "*",
    pagination: { offset: 0, limit: clampLimit(input.limit) },
    fields: ["applicationNumberText", "applicationMetaData", "parentContinuityBag", "childContinuityBag", "grantDocumentMetaData"]
  };
  if (rangeFilters.length) body.rangeFilters = rangeFilters;
  return body;
}

export function buildEpoQuery(input: SearchInput): string {
  const parts: string[] = [];
  const keywords = sanitizeWords(input.keywords);
  if (keywords.length) parts.push(`ta ${input.keywordMatch === "any" ? "any" : "all"} "${keywords.join(" ")}"`);
  const claims = sanitizeWords(input.claims);
  if (claims.length) parts.push(`cl all "${claims.join(" ")}"`);
  if (input.cpc) {
    const cpc = input.cpc.toUpperCase().replace(/\s+/g, "");
    if (!/^[A-HY][0-9]{2}[A-Z0-9/]*$/.test(cpc)) throw new PatentInputError("CPC class must look like H04L or C07H19/207.");
    parts.push(`cpc=${cpc}`);
  }
  const assignee = sanitizeWords(input.assignee).join(" ");
  if (input.assignee && !assignee) throw new PatentInputError("Assignee has no searchable letters.");
  if (assignee) parts.push(`pa all "${assignee}"`);
  const inventor = sanitizeWords(input.inventor).join(" ");
  if (input.inventor && !inventor) throw new PatentInputError("Inventor has no searchable letters.");
  if (inventor) parts.push(`in all "${inventor}"`);
  if (input.dateFrom) {
    if (!DATE_RE.test(input.dateFrom)) throw new PatentInputError("dateFrom must be YYYY-MM-DD.");
    parts.push(`pd>=${input.dateFrom.replace(/-/g, "")}`);
  }
  if (input.dateTo) {
    if (!DATE_RE.test(input.dateTo)) throw new PatentInputError("dateTo must be YYYY-MM-DD.");
    parts.push(`pd<=${input.dateTo.replace(/-/g, "")}`);
  }
  if (!parts.length) throw new PatentInputError("Provide a keyword, claim phrase, CPC symbol, assignee, inventor, or date.");
  return parts.join(" and ");
}

function phrase(value: string | undefined): string | undefined {
  const words = sanitizeWords(value);
  if (!words.length) return undefined;
  if (words.length === 1) return `${words[0]}*`;
  return `"${words.join(" ")}"`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 10;
  return Math.min(25, Math.max(1, Math.floor(limit)));
}

function namesFromBag(bag: unknown, textKey: string): string[] {
  const names: string[] = [];
  for (const item of asArray(bag)) {
    const record = asRecord(item);
    if (!record) continue;
    const text = asString(record[textKey]);
    if (text) {
      names.push(text);
      continue;
    }
    const first = asString(record.firstName);
    const last = asString(record.lastName);
    const joined = [first, last].filter(Boolean).join(" ");
    if (joined) names.push(joined);
  }
  return unique(names);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function mapUsptoWrapper(item: unknown): PatentRecord | null {
  const record = asRecord(item);
  if (!record) return null;
  const meta = asRecord(record.applicationMetaData) ?? {};
  const patentNumber = asString(meta.patentNumber);
  const publicationNumber = asString(meta.earliestPublicationNumber);
  const applicationNumber = asString(record.applicationNumberText);
  if (!patentNumber && !publicationNumber && !applicationNumber) return null;
  const cpc = asArray(meta.cpcClassificationBag).map(asString).filter((value): value is string => Boolean(value));
  const family = familyFromWrapper(record);
  const link = publicationNumber
    ? googlePatentsUrl("US", publicationNumber)
    : patentNumber
      ? googlePatentsUrl("US", patentNumber)
      : undefined;
  return {
    patentNumber,
    publicationNumber,
    applicationNumber,
    title: asString(meta.inventionTitle),
    status: asString(meta.applicationStatusDescriptionText),
    filingDate: asString(meta.filingDate),
    grantDate: asString(meta.grantDate),
    inventors: namesFromBag(meta.inventorBag, "inventorNameText"),
    assignees: namesFromBag(meta.applicantBag, "applicantNameText"),
    cpc,
    family,
    cited: [],
    citedBy: [],
    googlePatentsUrl: link,
    source: "USPTO Open Data Portal"
  };
}

function familyFromWrapper(record: Json): FamilyMember[] {
  const members: FamilyMember[] = [];
  for (const parent of asArray(record.parentContinuityBag)) {
    const item = asRecord(parent);
    if (!item) continue;
    const patentNumber = asString(item.parentPatentNumber);
    const applicationNumber = asString(item.parentApplicationNumberText);
    if (!patentNumber && !applicationNumber) continue;
    members.push({
      patentNumber,
      applicationNumber,
      relationship: asString(item.claimParentageTypeCodeDescriptionText),
      googlePatentsUrl: patentNumber ? googlePatentsUrl("US", patentNumber) : undefined,
      source: "USPTO Open Data Portal"
    });
  }
  for (const child of asArray(record.childContinuityBag)) {
    const item = asRecord(child);
    if (!item) continue;
    const patentNumber = asString(item.childPatentNumber);
    const applicationNumber = asString(item.childApplicationNumberText);
    if (!patentNumber && !applicationNumber) continue;
    members.push({
      patentNumber,
      applicationNumber,
      relationship: asString(item.claimParentageTypeCodeDescriptionText),
      googlePatentsUrl: patentNumber ? googlePatentsUrl("US", patentNumber) : undefined,
      source: "USPTO Open Data Portal"
    });
  }
  return members;
}

export function mapUsptoSearch(body: unknown): PatentRecord[] {
  const root = asRecord(body);
  return asArray(root?.patentFileWrapperDataBag).map(mapUsptoWrapper).filter((item): item is PatentRecord => Boolean(item));
}

export function grantXmlUri(body: unknown): string | undefined {
  const first = asRecord(asArray(asRecord(body)?.patentFileWrapperDataBag)[0]);
  return asString(asRecord(first?.grantDocumentMetaData)?.fileLocationURI);
}

export function parseUsptoGrantXml(xml: string): { abstract?: string; claims: string[]; cited: Citation[] } {
  const abstractBlock = xml.match(/<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i);
  const abstract = abstractBlock ? cleanXmlText(abstractBlock[1]) : undefined;
  const claims: string[] = [];
  const claimRe = /<claim-text\b[^>]*>([\s\S]*?)<\/claim-text>/gi;
  for (let match = claimRe.exec(xml); match && claims.length < 20; match = claimRe.exec(xml)) {
    const text = cleanXmlText(match[1]);
    if (text) claims.push(text.slice(0, 1500));
  }
  const cited: Citation[] = [];
  const patcitRe = /<patcit\b[^>]*>([\s\S]*?)<\/patcit>/gi;
  for (let match = patcitRe.exec(xml); match && cited.length < 40; match = patcitRe.exec(xml)) {
    const country = tagText(match[1], "country");
    const doc = tagText(match[1], "doc-number");
    if (!country || !doc) continue;
    const kind = tagText(match[1], "kind");
    cited.push({
      patentNumber: doc,
      publicationNumber: publicationId({ country, doc, kind }),
      googlePatentsUrl: googlePatentsUrl(country, doc),
      source: "USPTO grant document"
    });
  }
  return { abstract: abstract || undefined, claims, cited };
}

function tagText(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([^<]+)</${tag}>`, "i"));
  return match?.[1]?.trim() || undefined;
}

function cleanXmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const record = asRecord(value);
  if (!record) return undefined;
  return asString(record.$) ?? asString(record["#text"]);
}

export function collectDocumentIds(node: unknown, out: Array<{ country: string; doc: string; kind?: string }> = []): Array<{ country: string; doc: string; kind?: string }> {
  if (Array.isArray(node)) {
    for (const item of node) collectDocumentIds(item, out);
    return out;
  }
  const record = asRecord(node);
  if (!record) return out;
  const country = textOf(record.country ?? record["ops:country"]);
  const doc = textOf(record["doc-number"] ?? record["ops:doc-number"]);
  const kind = textOf(record.kind ?? record["ops:kind"]);
  if (country && doc && /^[A-Z]{2}$/.test(country) && /^[A-Z0-9]+$/.test(doc)) {
    out.push({ country, doc, kind });
  }
  for (const value of Object.values(record)) collectDocumentIds(value, out);
  return out;
}

export function publicationId(part: { country: string; doc: string; kind?: string }): string {
  const country = part.country.trim().toUpperCase();
  let doc = part.doc.trim();
  if (country && doc.toUpperCase().startsWith(country)) doc = doc.slice(country.length).trim();
  return `${country}${doc}${part.kind?.trim() ?? ""}`;
}

function flattenText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).filter(Boolean).join(" ");
  const record = asRecord(node);
  if (!record) return "";
  const direct = asString(record.$);
  if (direct && Object.keys(record).every((key) => key === "$" || key.startsWith("@"))) return direct;
  return Object.entries(record)
    .filter(([key]) => !key.startsWith("@"))
    .map(([, value]) => flattenText(value))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLabeledText(node: unknown, label: string): string | undefined {
  const found: string[] = [];
  const visit = (value: unknown) => {
    const record = asRecord(value);
    if (!record) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      const bare = key.split(":").pop()?.toLowerCase() ?? "";
      if (bare === label || bare.endsWith(`-${label}`)) {
        const text = flattenText(child).slice(0, 8000);
        if (text) found.push(text);
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return found[0];
}

export function mapEpoPublications(body: unknown, source: string): PatentRecord[] {
  const exchange = findKeyed(body, "exchange-document");
  const blocks = exchange.length ? exchange : findKeyed(body, "bibliographic-data");
  const nodes = blocks.length ? blocks : [body];
  const seen = new Set<string>();
  const patents: PatentRecord[] = [];
  for (const node of nodes) {
    const ids = collectDocumentIds(node);
    const title = ids.length === 1 || blocks.length ? extractLabeledText(node, "invention-title") : undefined;
    const abstract = ids.length === 1 || blocks.length ? extractLabeledText(node, "abstract") : undefined;
    for (const id of blocks.length ? ids.slice(0, 1) : ids) {
      const publicationNumber = publicationId(id);
      if (seen.has(publicationNumber)) continue;
      seen.add(publicationNumber);
      patents.push({
        publicationNumber,
        inventors: [],
        assignees: [],
        cpc: [],
        family: [],
        cited: [],
        citedBy: [],
        title,
        abstract,
        googlePatentsUrl: googlePatentsUrl(id.country, `${id.doc}${id.kind ?? ""}`),
        source
      });
    }
  }
  return patents;
}

function findKeyed(node: unknown, keyName: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) findKeyed(item, keyName, found);
    return found;
  }
  const record = asRecord(node);
  if (!record) return found;
  for (const [key, value] of Object.entries(record)) {
    const bare = key.split(":").pop()?.toLowerCase();
    if (bare === keyName) {
      if (Array.isArray(value)) found.push(...value);
      else found.push(value);
    } else {
      findKeyed(value, keyName, found);
    }
  }
  return found;
}

function dedupeKey(patent: PatentRecord): string {
  return (patent.publicationNumber ?? patent.patentNumber ?? patent.applicationNumber ?? "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

export function mergePatents(lists: PatentRecord[][]): PatentRecord[] {
  const map = new Map<string, PatentRecord>();
  for (const list of lists) {
    for (const patent of list) {
      const key = dedupeKey(patent);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...patent, family: [...patent.family], cited: [...patent.cited], citedBy: [...patent.citedBy] });
        continue;
      }
      existing.title ??= patent.title;
      existing.abstract ??= patent.abstract;
      existing.claims ??= patent.claims;
      existing.status ??= patent.status;
      existing.filingDate ??= patent.filingDate;
      existing.grantDate ??= patent.grantDate;
      existing.patentNumber ??= patent.patentNumber;
      existing.publicationNumber ??= patent.publicationNumber;
      existing.applicationNumber ??= patent.applicationNumber;
      existing.googlePatentsUrl ??= patent.googlePatentsUrl;
      existing.inventors = unique([...existing.inventors, ...patent.inventors]);
      existing.assignees = unique([...existing.assignees, ...patent.assignees]);
      existing.cpc = unique([...existing.cpc, ...patent.cpc]);
      existing.family = mergeMembers(existing.family, patent.family);
      existing.cited = mergeCitations(existing.cited, patent.cited);
      existing.citedBy = mergeCitations(existing.citedBy, patent.citedBy);
      if (!existing.source.includes(patent.source)) existing.source = `${existing.source}; ${patent.source}`;
    }
  }
  return [...map.values()];
}

function mergeMembers(left: FamilyMember[], right: FamilyMember[]): FamilyMember[] {
  const seen = new Set(left.map(memberKey));
  const out = [...left];
  for (const member of right) {
    const key = memberKey(member);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
}

function memberKey(member: FamilyMember): string {
  return (member.publicationNumber ?? member.patentNumber ?? member.applicationNumber ?? "").toUpperCase();
}

function mergeCitations(left: Citation[], right: Citation[]): Citation[] {
  const seen = new Set(left.map(citationKey));
  const out = [...left];
  for (const citation of right) {
    const key = citationKey(citation);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

function citationKey(citation: Citation): string {
  return (citation.publicationNumber ?? citation.patentNumber ?? citation.applicationNumber ?? "").toUpperCase();
}

export type PatentEnvelope = {
  disclaimer: string;
  sources: string[];
  warnings: string[];
  patents: PatentRecord[];
};

function envelope(patents: PatentRecord[], warnings: string[], sources: string[]): PatentEnvelope {
  return { disclaimer: DISCLAIMER, sources, warnings, patents };
}

export class PatentService {
  private epoToken?: { value: string; expiresAt: number };

  constructor(private readonly options: {
    fetchImpl?: typeof fetch;
    usptoApiKey?: string;
    epoConsumerKey?: string;
    epoConsumerSecret?: string;
    epoBase?: string;
  }) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  configured(): { uspto: boolean; epo: boolean } {
    return {
      uspto: Boolean(this.options.usptoApiKey),
      epo: Boolean(this.options.epoConsumerKey && this.options.epoConsumerSecret)
    };
  }

  async search(input: SearchInput): Promise<PatentEnvelope> {
    this.requireSource();
    const warnings: string[] = [];
    const sources: string[] = [];
    const lists: PatentRecord[][] = [];
    if (input.claims && !this.configured().epo) {
      warnings.push("USPTO file-wrapper search matches the claim words across application data.");
    }
    if (this.configured().uspto) {
      sources.push("USPTO Open Data Portal");
      try {
        lists.push(await this.usptoSearch(input));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "USPTO search failed.");
      }
    }
    if (this.configured().epo) {
      sources.push("EPO Open Patent Services");
      try {
        lists.push(await this.epoSearch(input));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "EPO search failed.");
      }
    }
    if (!lists.length && warnings.length) throw new PatentSourceError(warnings.join(" "));
    return envelope(mergePatents(lists).slice(0, clampLimit(input.limit)), warnings, sources);
  }

  async getPatent(rawId: string): Promise<PatentEnvelope> {
    this.requireSource();
    const id = normalizeOfficeId(rawId);
    const warnings: string[] = [];
    const sources: string[] = [];
    const lists: PatentRecord[][] = [];
    if (this.configured().uspto && (id.country === "US" || /^\d{8}$/.test(id.compact))) {
      sources.push("USPTO Open Data Portal");
      try {
        const found = await this.usptoGet(id);
        if (found) lists.push([found]);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "USPTO detail lookup failed.");
      }
    }
    if (this.configured().epo) {
      sources.push("EPO Open Patent Services");
      try {
        const found = await this.epoGet(id);
        if (found) lists.push([found]);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "EPO detail lookup failed.");
      }
    }
    const merged = mergePatents(lists);
    const requested = (id.usptoPatentDigits ?? id.epoRef).replace(/\D/g, "").replace(/^0+/, "");
    const matches = (patent: PatentRecord) => requested.length >= 5 && `${patent.patentNumber ?? ""}${patent.publicationNumber ?? ""}`.replace(/\D/g, "").includes(requested);
    const primary = merged.find(matches) ?? merged[0];
    if (primary) {
      for (const extra of merged) {
        if (extra === primary || !matches(extra)) continue;
        primary.abstract ??= extra.abstract;
        primary.claims ??= extra.claims;
        primary.title ??= extra.title;
        primary.status ??= extra.status;
        primary.filingDate ??= extra.filingDate;
        primary.grantDate ??= extra.grantDate;
        primary.googlePatentsUrl ??= extra.googlePatentsUrl;
        primary.inventors = unique([...primary.inventors, ...extra.inventors]);
        primary.assignees = unique([...primary.assignees, ...extra.assignees]);
        primary.cpc = unique([...primary.cpc, ...extra.cpc]);
        primary.family = mergeMembers(primary.family, extra.family);
        primary.cited = mergeCitations(primary.cited, extra.cited);
        primary.citedBy = mergeCitations(primary.citedBy, extra.citedBy);
        if (!primary.source.includes(extra.source)) primary.source = `${primary.source}; ${extra.source}`;
      }
    }
    const patents = primary ? [primary] : [];
    if (!patents.length && !warnings.length) {
      warnings.push(!this.configured().epo && id.country !== "US"
        ? "Patent covers US patents only. Try a US patent number (for example US10000000)."
        : "No office returned a record for that number.");
    }
    return envelope(patents, warnings, sources);
  }

  async citations(rawId: string, direction: "citing" | "cited_by" | "both"): Promise<PatentEnvelope & { cited: Citation[]; citedBy: Citation[] }> {
    const detail = await this.getPatent(rawId);
    const patent = detail.patents[0];
    const cited = direction === "citing" ? [] : patent?.cited ?? [];
    const citedBy = direction === "cited_by" ? [] : patent?.citedBy ?? [];
    return { ...detail, patents: patent ? [patent] : [], cited, citedBy };
  }

  async priorArt(idea: string, limit?: number): Promise<PatentEnvelope & { queryTerms: string[]; rankingNote: string }> {
    const terms = keywordsFromIdea(idea);
    if (terms.length < 2) {
      throw new PatentInputError("Describe the idea in a sentence with at least two distinctive words.");
    }
    const cap = clampLimit(limit);
    this.requireSource();
    const warnings: string[] = [];
    const sources: string[] = [];
    const lists: PatentRecord[][] = [];
    const remember = (message: string) => {
      if (message && !warnings.includes(message)) warnings.push(message);
    };
    // The file-wrapper index sorts by filing date. ANDing every keyword forced
    // each one into the same title and ordinary descriptions matched nothing.
    // One title search per keyword admits any hit; overlap ranking then keeps
    // the records that share the most words with the description.
    if (this.configured().uspto) {
      sources.push("USPTO Open Data Portal");
      const batches = await Promise.all(terms.map(async (term) => {
        try {
          return await this.usptoSearch({
            keywords: term,
            limit: 25,
            keywordMatch: "any",
            keywordField: "applicationMetaData.inventionTitle"
          });
        } catch (error) {
          remember(error instanceof Error ? error.message : "USPTO search failed.");
          return null;
        }
      }));
      for (const batch of batches) if (batch) lists.push(batch);
    }
    if (this.configured().epo) {
      sources.push("EPO Open Patent Services");
      try {
        lists.push(await this.epoSearch({ keywords: terms.join(" "), limit: 25, keywordMatch: "any" }));
      } catch (error) {
        remember(error instanceof Error ? error.message : "EPO search failed.");
      }
    }
    if (!lists.length && warnings.length) throw new PatentSourceError(warnings.join(" "));
    const ranked = rankByKeywordOverlap(terms, mergePatents(lists)).slice(0, cap);
    if (!ranked.length && !warnings.length) warnings.push("No office returned records for those terms.");
    return {
      ...envelope(ranked, warnings, sources),
      queryTerms: terms,
      rankingNote: "keywordOverlap counts idea words found in title or abstract text returned by the office. It is not a legal similarity opinion. Every number was copied from an office response."
    };
  }

  private requireSource() {
    if (!this.configured().uspto && !this.configured().epo) {
      throw new PatentSourceError(
        `No patent office credentials are configured. Set USPTO_API_KEY, or both EPO_CONSUMER_KEY and EPO_CONSUMER_SECRET. ${PRODUCT_NAME} does not invent patent numbers when an office API is unavailable. The legacy PatentsView PatentSearch API has been paused since the March 2026 move to the USPTO Open Data Portal.`
      );
    }
  }

  private async usptoSearch(input: SearchInput): Promise<PatentRecord[]> {
    const body = buildUsptoBody(input);
    try {
      const payload = await this.usptoJson(USPTO_SEARCH, "POST", body);
      return mapUsptoSearch(payload);
    } catch (error) {
      if (error instanceof PatentSourceError && error.message.includes("returned 404")) return [];
      throw error;
    }
  }

  private async usptoGet(id: OfficeId): Promise<PatentRecord | undefined> {
    const q = id.usptoPublication
      ? `applicationMetaData.earliestPublicationNumber:${id.usptoPublication}`
      : id.usptoPatentDigits
        ? `applicationMetaData.patentNumber:${id.usptoPatentDigits}`
        : `applicationNumberText:${id.compact}`;
    const payload = await this.usptoJson(USPTO_SEARCH, "POST", {
      q,
      pagination: { offset: 0, limit: 1 },
      fields: ["applicationNumberText", "applicationMetaData", "parentContinuityBag", "childContinuityBag", "grantDocumentMetaData"]
    });
    const patent = mapUsptoSearch(payload)[0];
    if (!patent) return undefined;
    const xmlUrl = grantXmlUri(payload);
    if (xmlUrl) {
      try {
        const xml = await this.usptoText(xmlUrl);
        const parsed = parseUsptoGrantXml(xml);
        if (parsed.abstract) patent.abstract = parsed.abstract;
        if (parsed.claims.length) patent.claims = parsed.claims;
        patent.cited = parsed.cited;
      } catch {
        // The bibliographic record still stands when the grant file cannot be read.
      }
    }
    if (patent.applicationNumber || patent.patentNumber) {
      patent.citedBy = await this.usptoForwardCitations(patent);
    }
    return patent;
  }

  private async usptoForwardCitations(patent: PatentRecord): Promise<Citation[]> {
    const digits = (patent.patentNumber ?? "").replace(/\D/g, "");
    if (!digits) return [];
    try {
      const payload = await this.usptoJson(USPTO_CITATIONS, "POST", {
        q: `referenceIdentifier:${digits}`,
        pagination: { offset: 0, limit: 25 }
      });
      return mapOfficeActionCitations(payload, digits);
    } catch {
      return [];
    }
  }

  private async usptoJson(url: string, method: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-api-key": this.options.usptoApiKey ?? ""
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new PatentSourceError("USPTO Open Data Portal rejected USPTO_API_KEY.");
    }
    if (!response.ok) throw new PatentSourceError(`USPTO Open Data Portal returned ${response.status}.`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new PatentSourceError("USPTO Open Data Portal returned a response that was not JSON.");
    }
  }

  private async usptoText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/xml, text/xml, */*",
        "user-agent": USER_AGENT,
        "x-api-key": this.options.usptoApiKey ?? ""
      },
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    if (!response.ok) throw new PatentSourceError(`USPTO document download returned ${response.status}.`);
    if (text.length > 8_000_000) throw new PatentSourceError("USPTO document was too large to read.");
    return text;
  }

  private async epoSearch(input: SearchInput): Promise<PatentRecord[]> {
    const query = buildEpoQuery(input);
    const limit = clampLimit(input.limit);
    const url = `${this.epoRoot()}/rest-services/published-data/search/biblio?q=${encodeURIComponent(query)}&Range=1-${limit}`;
    const payload = await this.epoJson(url);
    return mapEpoPublications(payload, "EPO Open Patent Services").slice(0, limit);
  }

  private async epoGet(id: OfficeId): Promise<PatentRecord | undefined> {
    const biblioUrl = `${this.epoRoot()}/rest-services/published-data/publication/epodoc/${encodeURIComponent(id.epoRef)}/biblio`;
    let biblio: unknown;
    try {
      biblio = await this.epoJson(biblioUrl);
    } catch (error) {
      if (error instanceof PatentSourceError && error.message.includes("404")) return undefined;
      throw error;
    }
    const patents = mapEpoPublications(biblio, "EPO Open Patent Services");
    const self = patents.find((patent) => (patent.publicationNumber ?? "").startsWith(id.epoRef)) ?? patents[0];
    if (!self) return undefined;
    self.title = extractLabeledText(biblio, "invention-title") ?? self.title;
    self.abstract = extractLabeledText(biblio, "abstract");
    const others = patents.filter((patent) => patent !== self);
    self.cited = others.slice(0, 40).map((patent) => ({
      publicationNumber: patent.publicationNumber,
      patentNumber: patent.patentNumber,
      googlePatentsUrl: patent.googlePatentsUrl,
      source: "EPO Open Patent Services bibliographic citations"
    }));
    const [abstractBody, claimsBody, familyBody, citingBody] = await Promise.all([
      this.epoOptional(`${this.epoRoot()}/rest-services/published-data/publication/epodoc/${encodeURIComponent(id.epoRef)}/abstract`),
      this.epoOptional(`${this.epoRoot()}/rest-services/published-data/publication/epodoc/${encodeURIComponent(id.epoRef)}/claims`),
      this.epoOptional(`${this.epoRoot()}/rest-services/family/publication/epodoc/${encodeURIComponent(id.epoRef)}`),
      this.epoOptional(`${this.epoRoot()}/rest-services/published-data/search?q=${encodeURIComponent(`ct=${id.epoRef}`)}&Range=1-25`)
    ]);
    if (abstractBody) self.abstract = extractLabeledText(abstractBody, "abstract") ?? extractLabeledText(abstractBody, "p") ?? self.abstract;
    if (claimsBody) {
      const claimsText = extractLabeledText(claimsBody, "claims") ?? extractLabeledText(claimsBody, "claim-text");
      if (claimsText) self.claims = claimsText.split(/(?=\b\d+\.\s)/).map((part) => part.trim()).filter(Boolean).slice(0, 20);
    }
    if (familyBody) {
      self.family = collectDocumentIds(familyBody)
        .map((part) => publicationId(part))
        .filter((publication) => publication !== self.publicationNumber)
        .filter((publication, index, all) => all.indexOf(publication) === index)
        .slice(0, 40)
        .map((publication) => ({
          publicationNumber: publication,
          googlePatentsUrl: googlePatentsUrl(publication.slice(0, 2), publication.slice(2)),
          source: "EPO Open Patent Services family"
        }));
    }
    if (citingBody) {
      self.citedBy = collectDocumentIds(citingBody)
        .map((part) => {
          const publicationNumber = publicationId(part);
          return {
            publicationNumber,
            googlePatentsUrl: googlePatentsUrl(part.country, `${part.doc}${part.kind ?? ""}`),
            source: "EPO Open Patent Services citation search"
          };
        })
        .filter((citation, index, all) => citation.publicationNumber !== self.publicationNumber && all.findIndex((item) => item.publicationNumber === citation.publicationNumber) === index)
        .slice(0, 25);
    }
    return self;
  }

  private epoRoot(): string {
    return (this.options.epoBase ?? "https://ops.epo.org/3.2").replace(/\/$/, "");
  }

  private async epoOptional(url: string): Promise<unknown | undefined> {
    try {
      return await this.epoJson(url);
    } catch {
      return undefined;
    }
  }

  private async epoJson(url: string): Promise<unknown> {
    const token = await this.epoAccessToken();
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT
      },
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) throw new PatentSourceError("EPO Open Patent Services rejected the consumer credentials.");
    if (response.status === 404) throw new PatentSourceError("EPO Open Patent Services returned 404.");
    if (!response.ok) throw new PatentSourceError(`EPO Open Patent Services returned ${response.status}.`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { xml: text };
    }
  }

  private async epoAccessToken(): Promise<string> {
    const cached = this.epoToken;
    if (cached && cached.expiresAt > Date.now() + 15000) return cached.value;
    const key = this.options.epoConsumerKey ?? "";
    const secret = this.options.epoConsumerSecret ?? "";
    const response = await this.fetchImpl(`${this.epoRoot()}/auth/accesstoken`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": USER_AGENT
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    if (!response.ok) throw new PatentSourceError("EPO Open Patent Services did not issue an access token.");
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number | string };
    if (!body.access_token) throw new PatentSourceError("EPO Open Patent Services token response had no access_token.");
    const expiresIn = Number(body.expires_in ?? 600);
    this.epoToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return body.access_token;
  }
}

export function mapOfficeActionCitations(body: unknown, targetDigits: string): Citation[] {
  const records = firstRecordArray(body);
  const citations: Citation[] = [];
  for (const item of records) {
    const record = asRecord(item);
    if (!record) continue;
    const blob = JSON.stringify(record);
    if (!blob.includes(targetDigits)) continue;
    const applicationNumber = asString(record.applicationNumberText) ?? asString(record.patentApplicationNumber) ?? asString(record.applicationNumber);
    const citingPublication = asString(record.citingPublicationNumber) ?? asString(record.publicationNumber);
    if (!applicationNumber && !citingPublication) continue;
    if (applicationNumber?.replace(/\D/g, "") === targetDigits) continue;
    citations.push({
      publicationNumber: citingPublication,
      applicationNumber,
      googlePatentsUrl: citingPublication && /^[A-Z]{2}/i.test(citingPublication)
        ? googlePatentsUrl(citingPublication.slice(0, 2), citingPublication.slice(2))
        : undefined,
      source: "USPTO office-action citations"
    });
  }
  return citations;
}

function firstRecordArray(body: unknown): unknown[] {
  const record = asRecord(body);
  if (!record) return [];
  for (const value of Object.values(record)) {
    if (Array.isArray(value) && value.some((item) => asRecord(item))) return value;
  }
  return [];
}

export function numbersInRecords(patents: Array<Pick<PatentRecord, "patentNumber" | "publicationNumber" | "applicationNumber" | "family" | "cited" | "citedBy">>): string[] {
  const numbers: string[] = [];
  const take = (value: string | undefined) => {
    if (value) numbers.push(value);
  };
  for (const patent of patents) {
    take(patent.patentNumber);
    take(patent.publicationNumber);
    take(patent.applicationNumber);
    for (const member of patent.family) {
      take(member.patentNumber);
      take(member.publicationNumber);
      take(member.applicationNumber);
    }
    for (const citation of [...patent.cited, ...patent.citedBy]) {
      take(citation.patentNumber);
      take(citation.publicationNumber);
      take(citation.applicationNumber);
    }
  }
  return numbers;
}
