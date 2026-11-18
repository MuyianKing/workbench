// 由 Workbench 随包内置（scripts/vendor-pi.mjs 复制到 resources/pi/web-search/），给 Pi 加两个工具：
//   web_search   —— 走 Exa 匿名 MCP（web_search_exa），零 key、零配置，返回标题 / URL / 摘要。
//   fetch_content —— 抓 URL、用 Readability 抽正文、turndown 转 Markdown，喂给模型。
// 刻意只做这两件事：没有 48 后端、key 配置、source_check、curator、视频 / PDF、斜杠命令、快捷键。
import { Type } from "typebox";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_TOOL = "web_search_exa";
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_CHARS = 5_000_000;

// ---------- 工具返回值的统一形状 ----------
function ok(text, details) {
	return { content: [{ type: "text", text }], details: details ?? {} };
}
function fail(text, details) {
	return { content: [{ type: "text", text: `Error: ${text}` }], details: details ?? { error: text } };
}

// ---------- web_search：Exa 匿名 MCP ----------
// 用全局 fetch 说 JSON-RPC；响应可能是 SSE（data: 行）或纯 JSON。
async function callExa(query, numResults, signal) {
	const response = await fetch(`${EXA_MCP_URL}?tools=${EXA_TOOL}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "workbench",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: EXA_TOOL, arguments: { query, numResults } },
		}),
		signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		const body = (await response.text()).slice(0, 300);
		throw new Error(`Exa MCP ${response.status}: ${body}`);
	}
	const body = await response.text();
	// 先试 SSE 的 data: 行，再试整段 JSON。
	const candidates = body.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(Boolean);
	candidates.push(body);
	for (const payload of candidates) {
		try {
			const parsed = JSON.parse(payload);
			if (parsed.error) throw new Error(parsed.error.message || "Exa MCP error");
			if (parsed.result?._meta?.["ai.exa/rateLimited"] === true)
				throw new Error("Exa 免费搜索达到速率限制，请稍后再试");
			if (parsed.result?.isError) {
				const msg = parsed.result.content?.find(c => c.type === "text" && typeof c.text === "string")?.text;
				throw new Error(msg?.trim() || "Exa MCP 返回错误");
			}
			const text = parsed.result?.content?.find(c => c.type === "text" && typeof c.text === "string" && c.text.trim())?.text;
			if (text) return text;
		}
		catch (err) {
			// 某一段解析失败继续试下一段；但真正的服务错误要往外抛。
			if (err instanceof Error && /rate limit|达到速率|Exa MCP error|Exa MCP 返回错误/.test(err.message)) throw err;
		}
	}
	throw new Error("Exa MCP 返回的内容无法解析");
}

// web_search_exa 返回的是 "Title:/URL:/Text:" 分块文本；这里只取标题和 URL。
function parseExaText(text) {
	const blocks = text.split(/(?=^Title: )/m).filter(b => b.trim());
	const results = [];
	for (const block of blocks) {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		if (!url) continue;
		let snippet = block.match(/^Text: (.+)/m)?.[1]?.trim() ?? "";
		if (!snippet) {
			const hl = block.match(/^Highlights:\s*\n([\s\S]+?)(?:\n---|$)/m)?.[1]?.trim() ?? "";
			snippet = hl;
		}
		results.push({ title: title || url, url, snippet: snippet.slice(0, 500) });
	}
	return results;
}

// ---------- fetch_content：抓网页 → Readability 抽正文 → turndown 转 Markdown ----------
function assertHttpUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	}
	catch {
		throw new Error(`不是合法的 URL：${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`只支持 http/https：${url.protocol}`);
	return url;
}

// 带有限重定向的 fetch（每跳都做一次协议校验，跨-origin 也放行但限次数）。
async function fetchPage(url, signal) {
	let current = url;
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const res = await fetch(current, { redirect: "manual", signal, headers: { Accept: "text/html,text/plain,*/*" } });
		if (res.status < 300 || res.status >= 400) return res;
		const location = res.headers.get("location");
		if (!location) return res;
		current = assertHttpUrl(new URL(location, current).toString());
	}
	throw new Error("重定向次数过多");
}

async function extractReadable(url, signal) {
	const res = await fetchPage(url, signal);
	if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
	const html = await res.text();
	if (html.length > MAX_HTML_CHARS) throw new Error("页面 HTML 过大，跳过");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	const { Readability } = await import("@mozilla/readability");
	const article = new Readability(document).parse();
	if (!article || typeof article.content !== "string")
		throw new Error("没能从页面里抽到正文（可能是动态渲染页面）");
	const { default: TurndownService } = await import("turndown");
	// turndown 收到字符串时会用自带解析器（@mixmark-io/domino，8.9MB），而它自带的那套 DOM 我们根本用不到：
	// 这里把 Readability 出的正文字符串用 linkedom 再解析成 DOM node 传进去，走 turndown 的 node 分支，
	// 就能在 vendor 时把 domino 换成最小 stub（见 vendor-pi.mjs），省 8.9MB。
	const { document: contentDoc } = parseHTML(`<x-tc-root>${article.content}</x-tc-root>`);
	const root = contentDoc.querySelector("x-tc-root");
	const markdown = new TurndownService().turndown(root);
	return { title: article.title?.trim() || document.title?.trim() || "", markdown };
}

// ---------- 注册工具 ----------
export default function (pi) {
	pi.registerTool({
		name: "web_search",
		label: "网页搜索",
		description: "搜索互联网，返回与查询相关的网页标题、链接和摘要。需要查资料、确认事实、找最新信息时用。默认走 Exa 匿名搜索，无需配置密钥。",
		promptSnippet: "用 web_search 搜索互联网查资料、找最新信息或确认事实。",
		parameters: Type.Object({
			query: Type.String({ description: "搜索关键词" }),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "返回结果条数，默认 5" })),
		}),
		async execute(_callId, params, signal) {
			if (!params.query?.trim()) return fail("查询不能为空");
			try {
				const text = await callExa(params.query.trim(), params.numResults ?? 5, signal);
				const results = parseExaText(text);
				if (!results.length) return fail("搜索没有返回可解析的结果", { raw: text.slice(0, 500) });
				const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
				return ok(`搜索「${params.query}」的结果：\n\n${lines.join("\n\n")}`, { results });
			}
			catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "抓取网页正文",
		description: "抓取指定 URL 的网页正文，提取可读内容并转成 Markdown 交给模型。用于阅读搜索结果里的页面、文档或文章。",
		promptSnippet: "用 fetch_content 读取某个具体 URL 的网页正文。",
		parameters: Type.Object({
			url: Type.String({ description: "要抓取的网页地址（http/https）" }),
		}),
		async execute(_callId, params, signal) {
			if (!params.url?.trim()) return fail("URL 不能为空");
			try {
				const url = assertHttpUrl(params.url.trim());
				const { title, markdown } = await extractReadable(url, signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS));
				if (!markdown.trim()) return fail("页面正文为空");
				const text = `来源：${url.toString()}${title ? `\n标题：${title}` : ""}\n\n${markdown}`;
				return ok(text, { url: url.toString(), title });
			}
			catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	});
}
