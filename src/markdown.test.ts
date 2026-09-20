import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import Markdown from "./markdown";

it("renders a decision table with intact cells, inline formatting and evidence links", () => {
  const body = `## 卡点：两个门禁

| 门禁 | 失败原因 | 解法 |
|---|---|---|
| \`review\` | **尚未指定评审人** | 指派一位评审人 |
| \`discussion\` | 有待处理的讨论 | [查看证据](evidence/check.md) |

需要你决定。`;
  const html = renderToStaticMarkup(createElement(Markdown, { body, basePath: "tasks/DEMO/" }));
  expect(html).toContain('<div class="markdown-table-scroll" role="region" aria-label="表格" tabindex="0"><table>');
  expect(html.match(/<th>/g)).toHaveLength(3);
  expect(html.match(/<td>/g)).toHaveLength(6);
  expect(html).toContain("<td><code>review</code></td>");
  expect(html).toContain("<td><strong>尚未指定评审人</strong></td>");
  expect(html).toContain('href="/api/pilot/files/tasks/DEMO/evidence/check.md"');
  expect(html).toContain("<p>需要你决定。</p>");
});

it("preserves table alignment and escaped pipes while leaving code samples and HTML inert", () => {
  const body = [
    "| 名称 | 数量 |", "| :--- | ---: |", "| A\\|B | 2 |", "",
    "```md", "| 原文 |", "| --- |", "```", "", '<script>alert("no")</script>',
  ].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { body }));
  expect(html.match(/<table>/g)).toHaveLength(1);
  expect(html).toContain('<th style="text-align:left">名称</th>');
  expect(html).toContain('<td style="text-align:right">2</td>');
  expect(html).toContain("A|B");
  expect(html).toContain('<pre><code class="language-md">| 原文 |\n| --- |\n</code></pre>');
  expect(html).not.toContain("<script>");
});
